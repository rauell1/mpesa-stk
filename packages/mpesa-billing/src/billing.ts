/**
 * The facade: five rails, one settlement contract.
 *
 * Every webhook handler here returns a `WebhookResult` — a framework-agnostic
 * `{ status, body }` plus the record this delivery settled, if any. Your
 * framework binding turns the reply into a Response; your application acts on
 * `settled`.
 */

import { randomUUID } from 'node:crypto'
import {
  parseC2B,
  parseJson,
  parsePayoutResult,
  parsePayoutTimeout,
  parseStkCallback,
  type ParsedC2B,
} from './callbacks.js'
import { isIpAllowed } from './config.js'
import {
  b2bPaymentRequest,
  b2cPaymentRequest,
  registerC2BUrls,
  stkPush,
  type B2BCommand,
  type B2BIdentifierType,
  type B2BResponse,
  type B2CCommand,
  type B2CResponse,
  type RegisterUrlResponse,
} from './daraja.js'
import { MPESA_CURRENCY, toMoney, type Money, type MoneyInput } from './money.js'
import {
  createCheckoutSession,
  sessionAmount,
  sessionPaymentIntentId,
  sessionReference,
  verifyStripeSignature,
  type CheckoutSession,
  type StripeEvent,
} from './stripe.js'
import type { ApplyInTransaction, BillingStore } from './adapters/types.js'
import type {
  BillingPayment,
  DarajaConfig,
  Logger,
  Rail,
  StripeConfig,
  WebhookContext,
  WebhookReply,
  WebhookResult,
} from './types.js'

/** M-PESA replies are always 200 — see the note on the inbound section below. */
const MPESA_OK: WebhookReply = { status: 200, body: { ResultCode: '0', ResultDesc: 'Success' } }
const MPESA_ACK: WebhookReply = { status: 200, body: { ResultCode: '0', ResultDesc: 'Acknowledged' } }

/**
 * A delivery from an IP we do not trust. Still a 200: telling an attacker
 * which of their forgeries was rejected, and why, is free information, and a
 * non-200 to a genuine Safaricom retry helps nobody.
 */
const MPESA_REJECTED: WebhookReply = {
  status: 200,
  body: { ResultCode: '0', ResultDesc: 'Acknowledged' },
}

const NO_RESULT = (reply: WebhookReply): WebhookResult => ({
  reply,
  settled: null,
  duplicate: false,
})

export type SettledHandler = (payment: BillingPayment) => void | Promise<void>

export interface BillingOptions {
  store: BillingStore
  mpesa?: DarajaConfig
  stripe?: StripeConfig
  logger?: Logger
  /**
   * Work to run inside the same database transaction as any settlement —
   * granting a plan, marking an order paid. Runs only for the delivery that
   * wins the compare-and-swap, so it is exactly-once with the settlement
   * itself. Throwing rolls the settlement back.
   */
  applyOnSettle?: ApplyInTransaction
  /**
   * Decide whether a C2B account number is one you accept, before Safaricom
   * moves the customer's money. Return false and the payment is declined at
   * the till. Default: accept anything non-empty — override it, or you will be
   * recording payments you cannot attribute.
   */
  validateC2BReference?: (reference: string, payload: ParsedC2B) => boolean | Promise<boolean>
  /**
   * Only accept M-PESA deliveries from these CIDR blocks.
   *
   * Safaricom signs nothing, so an unprotected C2B confirmation endpoint lets
   * anyone who knows the URL POST a payment that never happened — and unlike
   * the other rails, that one creates a settled row from scratch. Set this to
   * `SAFARICOM_CALLBACK_CIDRS` and give the handlers a `sourceIp`, or enforce
   * the same list at your WAF.
   *
   * Left unset, no check is made: the handlers cannot tell a missing
   * `sourceIp` from a spoofed one, and silently rejecting every delivery
   * behind a proxy that does not forward the IP would be worse than the gap it
   * closes.
   */
  trustedMpesaIps?: readonly string[]
  /** Defaults to crypto.randomUUID. */
  generateId?: () => string
}

export class Billing {
  private readonly store: BillingStore
  private readonly mpesaConfig: DarajaConfig | undefined
  private readonly stripeConfig: StripeConfig | undefined
  private readonly logger: Logger | undefined
  private readonly applyOnSettle: ApplyInTransaction | undefined
  private readonly validateC2BReference: BillingOptions['validateC2BReference']
  private readonly trustedMpesaIps: readonly string[] | undefined
  private readonly generateId: () => string
  private readonly settledHandlers: SettledHandler[] = []

  constructor(options: BillingOptions) {
    this.store = options.store
    this.mpesaConfig = options.mpesa
    this.stripeConfig = options.stripe
    this.logger = options.logger
    this.applyOnSettle = options.applyOnSettle
    this.validateC2BReference = options.validateC2BReference
    this.trustedMpesaIps = options.trustedMpesaIps
    this.generateId = options.generateId ?? (() => randomUUID())
  }

  /**
   * Fires once per payment that reaches a terminal state, on any rail, after
   * the settlement has committed. Use it for work that may lag — a receipt
   * email, an analytics event. Work that must be atomic with the settlement
   * belongs in `applyOnSettle`.
   */
  onPaymentSettled(handler: SettledHandler): void {
    this.settledHandlers.push(handler)
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Send the STK prompt and record a PENDING payment.
   *
   * No idempotency key: the record is keyed by the CheckoutRequestID Daraja
   * returns, which does not exist until the push has already been sent. If a
   * double-tapped "Pay" must not send two prompts, use the `mpesa-stk`
   * library, which owns that lifecycle.
   */
  async initiateStkPush(params: {
    reference: string
    phoneNumber: string
    /** KES. `{ amount: 500, currency: 'KES' }` or `{ minor: 50000, currency: 'KES' }`. */
    amount: MoneyInput
    accountReference?: string
    description?: string
    transactionType?: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
  }): Promise<{ payment: BillingPayment; customerMessage: string }> {
    const config = this.requireMpesa()
    const amount = toMoney(params.amount)

    const response = await stkPush(config, this.store, {
      phoneNumber: params.phoneNumber,
      amount,
      accountReference: params.accountReference ?? params.reference,
      description: params.description ?? 'Payment',
      ...(params.transactionType ? { transactionType: params.transactionType } : {}),
    })

    const payment = await this.store.createPayment({
      id: this.generateId(),
      rail: 'stk',
      reference: params.reference,
      providerRef: response.CheckoutRequestID,
      amount,
      status: 'PENDING',
      payerRef: params.phoneNumber,
      createdAt: new Date(),
    })

    if (!payment) {
      // Daraja reused a CheckoutRequestID we already hold. Never observed, but
      // silently overwriting a live payment would be the wrong way to find out.
      throw new Error(`CheckoutRequestID ${response.CheckoutRequestID} is already recorded`)
    }

    return { payment, customerMessage: response.CustomerMessage }
  }

  /** Register this app's C2B validation and confirmation URLs for the shortcode. */
  async registerC2BUrls(responseType?: 'Completed' | 'Cancelled'): Promise<RegisterUrlResponse> {
    return registerC2BUrls(this.requireMpesa(), this.store, responseType)
  }

  /** Pay out to a customer's phone. The outcome arrives on the result or timeout URL. */
  async initiateB2C(params: {
    reference: string
    phoneNumber: string
    amount: MoneyInput
    remarks: string
    occasion?: string
    commandId?: B2CCommand
  }): Promise<{ payment: BillingPayment; response: B2CResponse }> {
    const config = this.requireMpesa()
    const amount = toMoney(params.amount)

    const response = await b2cPaymentRequest(config, this.store, {
      phoneNumber: params.phoneNumber,
      amount,
      remarks: params.remarks,
      ...(params.occasion !== undefined ? { occasion: params.occasion } : {}),
      ...(params.commandId !== undefined ? { commandId: params.commandId } : {}),
    })

    const payment = await this.recordPayout('b2c', params.reference, response, amount, params.phoneNumber)
    return { payment, response }
  }

  /**
   * Pay another business — their paybill or till. The outcome arrives on the
   * B2B result or timeout URL.
   *
   * `BusinessPayBill` (the default) needs an `accountReference`: it is the
   * account number the receiving organisation will see on their statement, and
   * Daraja rejects the request without it.
   */
  async initiateB2B(params: {
    reference: string
    receiverShortCode: string
    amount: MoneyInput
    remarks: string
    accountReference?: string
    commandId?: B2BCommand
    senderIdentifierType?: B2BIdentifierType
    receiverIdentifierType?: B2BIdentifierType
    requesterPhoneNumber?: string
  }): Promise<{ payment: BillingPayment; response: B2BResponse }> {
    const config = this.requireMpesa()
    const amount = toMoney(params.amount)

    const response = await b2bPaymentRequest(config, this.store, {
      receiverShortCode: params.receiverShortCode,
      amount,
      remarks: params.remarks,
      ...(params.accountReference !== undefined ? { accountReference: params.accountReference } : {}),
      ...(params.commandId !== undefined ? { commandId: params.commandId } : {}),
      ...(params.senderIdentifierType !== undefined
        ? { senderIdentifierType: params.senderIdentifierType }
        : {}),
      ...(params.receiverIdentifierType !== undefined
        ? { receiverIdentifierType: params.receiverIdentifierType }
        : {}),
      ...(params.requesterPhoneNumber !== undefined
        ? { requesterPhoneNumber: params.requesterPhoneNumber }
        : {}),
    })

    const payment = await this.recordPayout(
      'b2b',
      params.reference,
      response,
      amount,
      params.receiverShortCode,
    )
    return { payment, response }
  }

  /** Both payout rails record the same way, keyed on the ConversationID. */
  private async recordPayout(
    rail: 'b2c' | 'b2b',
    reference: string,
    response: { ConversationID: string },
    amount: Money,
    payeeRef: string,
  ): Promise<BillingPayment> {
    const payment = await this.store.createPayment({
      id: this.generateId(),
      rail,
      reference,
      providerRef: response.ConversationID,
      amount,
      status: 'PENDING',
      payerRef: payeeRef,
      createdAt: new Date(),
    })

    if (!payment) {
      throw new Error(`ConversationID ${response.ConversationID} is already recorded`)
    }
    return payment
  }

  /**
   * Open a Stripe Checkout session and record a PENDING payment against it.
   *
   * The amount is a `Money` like every other rail — `{ amount: '5.00',
   * currency: 'USD' }`, not a bare count of cents. It is converted to Stripe's
   * `unit_amount` at the boundary.
   */
  async createStripeCheckout(params: {
    reference: string
    amount: MoneyInput
    successUrl: string
    cancelUrl: string
    productName?: string
    idempotencyKey?: string
    metadata?: Record<string, string>
  }): Promise<{ payment: BillingPayment; session: CheckoutSession }> {
    const config = this.requireStripe()
    const amount = toMoney(params.amount)

    const session = await createCheckoutSession(config, {
      reference: params.reference,
      amount,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      ...(params.productName !== undefined ? { productName: params.productName } : {}),
      ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    })

    const created = await this.store.createPayment({
      id: this.generateId(),
      rail: 'stripe',
      reference: params.reference,
      providerRef: session.id,
      amount,
      status: 'PENDING',
      createdAt: new Date(),
    })

    // A retry carrying the same idempotency key gets the same session back from
    // Stripe, so the row already exists — a re-issue, not a second payment.
    const existing = created ?? (await this.store.getPayment('stripe', session.id))
    if (!existing) throw new Error(`Could not record Stripe session ${session.id}`)

    return { payment: existing, session }
  }

  // -------------------------------------------------------------------------
  // Inbound — M-PESA
  //
  // Every M-PESA handler answers 200, including on an internal error.
  // Safaricom's retry replays the same delivery into the same failure, and a
  // non-200 on the C2B confirmation asks it to re-send money we have already
  // taken. Recovery is reconciliation, not the retry.
  // -------------------------------------------------------------------------

  /** False when `trustedMpesaIps` is set and this delivery is not from one. */
  private isTrusted(context: WebhookContext | undefined, handler: string): boolean {
    if (!this.trustedMpesaIps) return true
    if (isIpAllowed(context?.sourceIp, this.trustedMpesaIps)) return true
    this.logger?.warn('[billing] rejected an M-PESA delivery from an untrusted source', {
      handler,
      sourceIp: context?.sourceIp ?? '(none supplied)',
    })
    return false
  }

  async handleStkCallback(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    if (!this.isTrusted(context, 'stkCallback')) return NO_RESULT(MPESA_REJECTED)

    try {
      const body = parseJson(rawBody)
      const parsed = parseStkCallback(body)
      if (!parsed) {
        this.logger?.warn('[billing] STK callback could not be parsed')
        return NO_RESULT(MPESA_ACK)
      }

      const settled = await this.store.settlePayment(
        'stk',
        parsed.checkoutRequestId,
        parsed.succeeded
          ? {
              status: 'SUCCESS',
              ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
              ...(parsed.phoneNumber ? { payerRef: parsed.phoneNumber } : {}),
              ...(parsed.amount ? { settledAmount: parsed.amount } : {}),
              raw: body,
            }
          : {
              status: 'FAILED',
              failureCode: String(parsed.resultCode),
              failureReason: parsed.resultDesc,
              raw: body,
            },
        this.applyOnSettle,
      )

      await this.emitSettled(settled)
      return { reply: MPESA_OK, settled, duplicate: settled === null }
    } catch (error) {
      this.logger?.error('[billing] STK callback failed', { error })
      return NO_RESULT(MPESA_ACK)
    }
  }

  /**
   * The only gate before Safaricom moves a C2B customer's money.
   *
   * Rejections are 200 responses carrying a C2B error code; a non-200 is read
   * as "validator down", which the shortcode's ResponseType setting resolves,
   * not this handler. An internal error rejects too: we could not attribute
   * the payment, and an unattributable payment costs more to unwind than a
   * declined one costs to retry.
   */
  async handleC2BValidation(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    const decline = (code: string, desc: string): WebhookResult =>
      NO_RESULT({ status: 200, body: { ResultCode: code, ResultDesc: desc } })

    if (!this.isTrusted(context, 'c2bValidation')) return decline('C2B00016', 'Unable to validate.')

    try {
      const parsed = parseC2B(parseJson(rawBody))
      if (!parsed) return decline('C2B00012', 'Invalid account number.')

      const accepted = this.validateC2BReference
        ? await this.validateC2BReference(parsed.reference, parsed)
        : parsed.reference.length > 0

      if (!accepted) return decline('C2B00012', 'Account not found.')

      return NO_RESULT({ status: 200, body: { ResultCode: '0', ResultDesc: 'Accepted' } })
    } catch (error) {
      this.logger?.error('[billing] C2B validation failed', { error })
      return decline('C2B00016', 'Unable to validate. Please try again.')
    }
  }

  /**
   * The money has moved. There is no PENDING row to settle — C2B starts at the
   * customer's phone — so the insert itself is the guard: the UNIQUE
   * constraint on Safaricom's TransID makes a replayed confirmation a no-op.
   *
   * This is the one handler that creates a settled payment from nothing, which
   * is why `trustedMpesaIps` matters most here.
   */
  async handleC2BConfirmation(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    if (!this.isTrusted(context, 'c2bConfirmation')) return NO_RESULT(MPESA_REJECTED)

    try {
      const body = parseJson(rawBody)
      const parsed = parseC2B(body)
      if (!parsed) {
        this.logger?.warn('[billing] C2B confirmation could not be parsed')
        return NO_RESULT(MPESA_ACK)
      }

      const now = new Date()
      const recorded = await this.store.recordSettledPayment(
        {
          id: this.generateId(),
          rail: 'c2b',
          reference: parsed.reference,
          providerRef: parsed.transId,
          amount: parsed.amount,
          settledAmount: parsed.amount,
          status: 'SUCCESS',
          payerRef: parsed.msisdn,
          receipt: parsed.transId,
          raw: body,
          createdAt: now,
          settledAt: now,
        },
        this.applyOnSettle,
      )

      await this.emitSettled(recorded)
      return { reply: MPESA_OK, settled: recorded, duplicate: recorded === null }
    } catch (error) {
      this.logger?.error('[billing] C2B confirmation failed', { error })
      return NO_RESULT(MPESA_ACK)
    }
  }

  async handleB2CResult(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    return this.handlePayoutResult('b2c', rawBody, context)
  }

  async handleB2BResult(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    return this.handlePayoutResult('b2b', rawBody, context)
  }

  async handleB2CTimeout(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    return this.handlePayoutTimeout('b2c', rawBody, context)
  }

  async handleB2BTimeout(rawBody: string, context?: WebhookContext): Promise<WebhookResult> {
    return this.handlePayoutTimeout('b2b', rawBody, context)
  }

  /**
   * B2C and B2B share the `Result` envelope, so they share this handler.
   *
   * The receipt and the amount that actually moved come from
   * `ResultParameters`; a payout recorded without them is a payout you cannot
   * reconcile against the statement.
   */
  private async handlePayoutResult(
    rail: 'b2c' | 'b2b',
    rawBody: string,
    context: WebhookContext | undefined,
  ): Promise<WebhookResult> {
    if (!this.isTrusted(context, `${rail}Result`)) return NO_RESULT(MPESA_REJECTED)

    try {
      const body = parseJson(rawBody)
      const parsed = parsePayoutResult(body)
      if (!parsed) {
        this.logger?.warn(`[billing] ${rail.toUpperCase()} result could not be parsed`)
        return NO_RESULT(MPESA_ACK)
      }

      const settled = await this.store.settlePayment(
        rail,
        parsed.conversationId,
        parsed.succeeded
          ? {
              status: 'SUCCESS',
              ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
              ...(parsed.amount ? { settledAmount: parsed.amount } : {}),
              raw: body,
            }
          : {
              status: 'FAILED',
              failureCode: String(parsed.resultCode),
              failureReason: parsed.resultDesc,
              raw: body,
            },
        this.applyOnSettle,
      )

      await this.emitSettled(settled)
      return { reply: MPESA_ACK, settled, duplicate: settled === null }
    } catch (error) {
      this.logger?.error(`[billing] ${rail.toUpperCase()} result failed`, { error })
      return NO_RESULT(MPESA_ACK)
    }
  }

  /**
   * The payout expired in Safaricom's queue. That is not the same as "the
   * money did not move" — it is marked failed here, and only a transaction
   * status query against Daraja can confirm it either way. The CAS means a
   * result that already settled the payout wins over a late timeout.
   */
  private async handlePayoutTimeout(
    rail: 'b2c' | 'b2b',
    rawBody: string,
    context: WebhookContext | undefined,
  ): Promise<WebhookResult> {
    if (!this.isTrusted(context, `${rail}Timeout`)) return NO_RESULT(MPESA_REJECTED)

    try {
      const body = parseJson(rawBody)
      const parsed = parsePayoutTimeout(body)
      if (!parsed) {
        this.logger?.warn(`[billing] ${rail.toUpperCase()} timeout could not be parsed`)
        return NO_RESULT(MPESA_ACK)
      }

      const settled = await this.store.settlePayment(
        rail,
        parsed.conversationId,
        {
          status: 'FAILED',
          failureCode: 'TIMEOUT',
          failureReason: 'Request timed out in the Daraja queue',
          raw: body,
        },
        this.applyOnSettle,
      )

      await this.emitSettled(settled)
      return { reply: MPESA_ACK, settled, duplicate: settled === null }
    } catch (error) {
      this.logger?.error(`[billing] ${rail.toUpperCase()} timeout failed`, { error })
      return NO_RESULT(MPESA_ACK)
    }
  }

  // -------------------------------------------------------------------------
  // Inbound — Stripe
  //
  // The opposite convention to M-PESA, deliberately: Stripe redelivers with
  // backoff for three days, so a transient failure SHOULD return 500 and be
  // retried. Only a bad signature is a permanent 400.
  // -------------------------------------------------------------------------

  async handleStripeWebhook(rawBody: string, signatureHeader: string | null): Promise<WebhookResult> {
    let config: StripeConfig
    try {
      config = this.requireStripe()
    } catch (error) {
      // Misconfiguration, not a bad delivery. 500 so Stripe retries once the
      // config is fixed, rather than 400 discarding a real payment.
      this.logger?.error('[billing] Stripe webhook received with no stripe config', { error })
      return NO_RESULT({ status: 500, body: { error: 'Stripe is not configured' } })
    }

    if (!verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret, config.toleranceSeconds)) {
      // Without this check, anyone who knows the URL can POST a completed
      // session and pay for nothing.
      this.logger?.warn('[billing] Stripe signature verification failed')
      return NO_RESULT({ status: 400, body: { error: 'Invalid signature' } })
    }

    const event = parseJson(rawBody) as StripeEvent | null
    if (!event?.type || !event.data?.object) {
      return NO_RESULT({ status: 200, body: { received: true } })
    }

    try {
      const session = event.data.object
      let settled: BillingPayment | null = null

      switch (event.type) {
        case 'checkout.session.completed':
          // `payment_status` guards the asynchronous methods (bank debits),
          // where the session completes before the money settles.
          if (session.payment_status !== 'unpaid') {
            settled = await this.settleStripeSession(event, 'SUCCESS')
          }
          break

        case 'checkout.session.async_payment_succeeded':
          settled = await this.settleStripeSession(event, 'SUCCESS')
          break

        case 'checkout.session.async_payment_failed':
        case 'checkout.session.expired':
          settled = await this.settleStripeSession(event, 'FAILED')
          break

        default:
          break
      }

      await this.emitSettled(settled)
      return {
        reply: { status: 200, body: { received: true } },
        settled,
        duplicate: settled === null,
      }
    } catch (error) {
      this.logger?.error('[billing] Stripe webhook failed', { type: event.type, error })
      return NO_RESULT({ status: 500, body: { error: 'Processing failed' } })
    }
  }

  private async settleStripeSession(
    event: StripeEvent,
    status: 'SUCCESS' | 'FAILED',
  ): Promise<BillingPayment | null> {
    const session = event.data.object
    if (!sessionReference(session)) {
      this.logger?.warn('[billing] Stripe session carries no reference', { session: session.id })
      return null
    }

    const intentId = sessionPaymentIntentId(session)
    // amount_total is in minor units and currency is lowercase; sessionAmount
    // turns that back into the same Money the checkout was created with.
    const paid = status === 'SUCCESS' ? sessionAmount(session) : undefined

    return this.store.settlePayment(
      'stripe',
      session.id,
      {
        status,
        ...(intentId ? { receipt: intentId } : {}),
        ...(paid ? { settledAmount: paid } : {}),
        ...(status === 'FAILED' ? { failureCode: event.type } : {}),
        raw: event,
      },
      this.applyOnSettle,
    )
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getPayment(rail: Rail, providerRef: string): Promise<BillingPayment | null> {
    return this.store.getPayment(rail, providerRef)
  }

  getPaymentByReference(rail: Rail, reference: string): Promise<BillingPayment | null> {
    return this.store.getPaymentByReference(rail, reference)
  }

  // -------------------------------------------------------------------------

  private async emitSettled(payment: BillingPayment | null): Promise<void> {
    if (!payment) return
    for (const handler of this.settledHandlers) {
      try {
        await handler(payment)
      } catch (error) {
        // A failing listener must not turn into a non-200 that makes the
        // provider redeliver a payment we have already committed.
        this.logger?.error('[billing] onPaymentSettled handler threw', { id: payment.id, error })
      }
    }
  }

  private requireMpesa(): DarajaConfig {
    if (!this.mpesaConfig) throw new Error('Billing was constructed without an mpesa config')
    return this.mpesaConfig
  }

  private requireStripe(): StripeConfig {
    if (!this.stripeConfig) throw new Error('Billing was constructed without a stripe config')
    return this.stripeConfig
  }
}

export { MPESA_CURRENCY }
