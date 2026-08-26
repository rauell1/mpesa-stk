/**
 * The facade: four rails, one settlement contract.
 *
 * Every webhook handler here returns a `WebhookResult` — a framework-agnostic
 * `{ status, body }` plus the record this delivery settled, if any. Your
 * framework binding turns the reply into a Response; your application acts on
 * `settled`.
 */

import { randomUUID } from 'node:crypto'
import {
  parseB2CResult,
  parseB2CTimeout,
  parseC2B,
  parseJson,
  parseStkCallback,
  type ParsedC2B,
} from './callbacks.js'
import { b2cPaymentRequest, registerC2BUrls, stkPush, type B2CCommand, type B2CResponse, type RegisterUrlResponse } from './daraja.js'
import {
  createCheckoutSession,
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
  StripeConfig,
  WebhookReply,
  WebhookResult,
} from './types.js'

/** M-PESA replies are always 200 — see the note on `acknowledged` below. */
const MPESA_OK: WebhookReply = { status: 200, body: { ResultCode: '0', ResultDesc: 'Success' } }
const MPESA_ACK: WebhookReply = { status: 200, body: { ResultCode: '0', ResultDesc: 'Acknowledged' } }

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
  private readonly generateId: () => string
  private readonly settledHandlers: SettledHandler[] = []

  constructor(options: BillingOptions) {
    this.store = options.store
    this.mpesaConfig = options.mpesa
    this.stripeConfig = options.stripe
    this.logger = options.logger
    this.applyOnSettle = options.applyOnSettle
    this.validateC2BReference = options.validateC2BReference
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
    amount: number
    accountReference?: string
    description?: string
  }): Promise<{ payment: BillingPayment; customerMessage: string }> {
    const config = this.requireMpesa()

    const response = await stkPush(config, this.store, {
      phoneNumber: params.phoneNumber,
      amount: params.amount,
      accountReference: params.accountReference ?? params.reference,
      description: params.description ?? 'Payment',
    })

    const payment = await this.store.createPayment({
      id: this.generateId(),
      rail: 'stk',
      reference: params.reference,
      providerRef: response.CheckoutRequestID,
      amount: String(params.amount),
      currency: 'kes',
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

  /** Send a payout. The outcome arrives later on the result or timeout URL. */
  async initiateB2C(params: {
    reference: string
    phoneNumber: string
    amount: number
    remarks: string
    occasion?: string
    commandId?: B2CCommand
  }): Promise<{ payment: BillingPayment; response: B2CResponse }> {
    const config = this.requireMpesa()

    const request: Parameters<typeof b2cPaymentRequest>[2] = {
      phoneNumber: params.phoneNumber,
      amount: params.amount,
      remarks: params.remarks,
    }
    if (params.occasion !== undefined) request.occasion = params.occasion
    if (params.commandId !== undefined) request.commandId = params.commandId

    const response = await b2cPaymentRequest(config, this.store, request)

    const payment = await this.store.createPayment({
      id: this.generateId(),
      rail: 'b2c',
      reference: params.reference,
      providerRef: response.ConversationID,
      amount: String(params.amount),
      currency: 'kes',
      status: 'PENDING',
      payerRef: params.phoneNumber,
      createdAt: new Date(),
    })

    if (!payment) throw new Error(`ConversationID ${response.ConversationID} is already recorded`)

    return { payment, response }
  }

  /** Open a Stripe Checkout session and record a PENDING payment against it. */
  async createStripeCheckout(params: {
    reference: string
    amount: number
    currency?: string
    successUrl: string
    cancelUrl: string
    productName?: string
    idempotencyKey?: string
    metadata?: Record<string, string>
  }): Promise<{ payment: BillingPayment; session: CheckoutSession }> {
    const config = this.requireStripe()

    const sessionParams: Parameters<typeof createCheckoutSession>[1] = {
      reference: params.reference,
      amount: params.amount,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    }
    if (params.currency !== undefined) sessionParams.currency = params.currency
    if (params.productName !== undefined) sessionParams.productName = params.productName
    if (params.idempotencyKey !== undefined) sessionParams.idempotencyKey = params.idempotencyKey
    if (params.metadata !== undefined) sessionParams.metadata = params.metadata

    const session = await createCheckoutSession(config, sessionParams)

    const created = await this.store.createPayment({
      id: this.generateId(),
      rail: 'stripe',
      reference: params.reference,
      providerRef: session.id,
      amount: String(params.amount),
      currency: (params.currency ?? 'usd').toLowerCase(),
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

  async handleStkCallback(rawBody: string): Promise<WebhookResult> {
    try {
      const body = parseJson(rawBody)
      const parsed = parseStkCallback(body)
      if (!parsed) {
        this.logger?.warn('[billing] STK callback could not be parsed')
        return { reply: MPESA_ACK, settled: null, duplicate: false }
      }

      const settled = await this.store.settlePayment(
        'stk',
        parsed.checkoutRequestId,
        parsed.succeeded
          ? {
              status: 'SUCCESS',
              ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
              ...(parsed.phoneNumber ? { payerRef: parsed.phoneNumber } : {}),
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
      return { reply: MPESA_ACK, settled: null, duplicate: false }
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
  async handleC2BValidation(rawBody: string): Promise<WebhookResult> {
    try {
      const parsed = parseC2B(parseJson(rawBody))
      if (!parsed) {
        return {
          reply: {
            status: 200,
            body: { ResultCode: 'C2B00012', ResultDesc: 'Invalid account number.' },
          },
          settled: null,
          duplicate: false,
        }
      }

      const accepted = this.validateC2BReference
        ? await this.validateC2BReference(parsed.reference, parsed)
        : parsed.reference.length > 0

      if (!accepted) {
        return {
          reply: {
            status: 200,
            body: { ResultCode: 'C2B00012', ResultDesc: 'Account not found.' },
          },
          settled: null,
          duplicate: false,
        }
      }

      return {
        reply: { status: 200, body: { ResultCode: '0', ResultDesc: 'Accepted' } },
        settled: null,
        duplicate: false,
      }
    } catch (error) {
      this.logger?.error('[billing] C2B validation failed', { error })
      return {
        reply: {
          status: 200,
          body: { ResultCode: 'C2B00016', ResultDesc: 'Unable to validate. Please try again.' },
        },
        settled: null,
        duplicate: false,
      }
    }
  }

  /**
   * The money has moved. There is no PENDING row to settle — C2B starts at the
   * customer's phone — so the insert itself is the guard: the UNIQUE
   * constraint on Safaricom's TransID makes a replayed confirmation a no-op.
   */
  async handleC2BConfirmation(rawBody: string): Promise<WebhookResult> {
    try {
      const body = parseJson(rawBody)
      const parsed = parseC2B(body)
      if (!parsed) {
        this.logger?.warn('[billing] C2B confirmation could not be parsed')
        return { reply: MPESA_ACK, settled: null, duplicate: false }
      }

      const now = new Date()
      const recorded = await this.store.recordSettledPayment(
        {
          id: this.generateId(),
          rail: 'c2b',
          reference: parsed.reference,
          providerRef: parsed.transId,
          amount: parsed.amount,
          currency: 'kes',
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
      return { reply: MPESA_ACK, settled: null, duplicate: false }
    }
  }

  async handleB2CResult(rawBody: string): Promise<WebhookResult> {
    try {
      const body = parseJson(rawBody)
      const parsed = parseB2CResult(body)
      if (!parsed) {
        this.logger?.warn('[billing] B2C result could not be parsed')
        return { reply: MPESA_ACK, settled: null, duplicate: false }
      }

      const settled = await this.store.settlePayment(
        'b2c',
        parsed.conversationId,
        parsed.succeeded
          ? { status: 'SUCCESS', ...(parsed.receipt ? { receipt: parsed.receipt } : {}), raw: body }
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
      this.logger?.error('[billing] B2C result failed', { error })
      return { reply: MPESA_ACK, settled: null, duplicate: false }
    }
  }

  /**
   * The payout expired in Safaricom's queue. That is not the same as "the
   * money did not move" — it is marked failed here, and only a status query
   * against Daraja can confirm it.
   */
  async handleB2CTimeout(rawBody: string): Promise<WebhookResult> {
    try {
      const body = parseJson(rawBody)
      const parsed = parseB2CTimeout(body)
      if (!parsed) {
        this.logger?.warn('[billing] B2C timeout could not be parsed')
        return { reply: MPESA_ACK, settled: null, duplicate: false }
      }

      const settled = await this.store.settlePayment(
        'b2c',
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
      this.logger?.error('[billing] B2C timeout failed', { error })
      return { reply: MPESA_ACK, settled: null, duplicate: false }
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
    const config = this.requireStripe()

    if (!verifyStripeSignature(rawBody, signatureHeader, config.webhookSecret, config.toleranceSeconds)) {
      // Without this check, anyone who knows the URL can POST a completed
      // session and pay for nothing.
      this.logger?.warn('[billing] Stripe signature verification failed')
      return {
        reply: { status: 400, body: { error: 'Invalid signature' } },
        settled: null,
        duplicate: false,
      }
    }

    const event = parseJson(rawBody) as StripeEvent | null
    if (!event?.type || !event.data?.object) {
      return { reply: { status: 200, body: { received: true } }, settled: null, duplicate: false }
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
      return { reply: { status: 500, body: { error: 'Processing failed' } }, settled: null, duplicate: false }
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

    return this.store.settlePayment(
      'stripe',
      session.id,
      {
        status,
        ...(intentId ? { receipt: intentId } : {}),
        ...(status === 'FAILED' ? { failureCode: event.type } : {}),
        raw: event,
      },
      this.applyOnSettle,
    )
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
