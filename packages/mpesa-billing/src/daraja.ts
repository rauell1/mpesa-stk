/**
 * Daraja HTTP calls: OAuth, STK Push, C2B URL registration, B2C and B2B
 * payouts.
 *
 * These are the outbound half. The inbound half — what Safaricom POSTs back —
 * lives in callbacks.ts.
 */

import {
  assertShortCode,
  baseUrl,
  callbackUrl,
  eatTimestamp,
  fetchWithTimeout,
  normalisePhone,
  securityCredential,
  stkPassword,
} from './config.js'
import { toDarajaAmount, type Money } from './money.js'
import type { BillingStore } from './adapters/types.js'
import type { DarajaConfig } from './types.js'

/**
 * Drop a cached token this long before Daraja expires it. A token that is
 * valid when read and expired when used returns a 401 from the payment call,
 * which costs far more than minting one a minute early.
 */
const TOKEN_MARGIN_MS = 60_000

const DEFAULT_TIMEOUT_MS = 30_000

interface TokenResponse {
  access_token: string
  expires_in: string
}

export interface StkPushResponse {
  MerchantRequestID: string
  CheckoutRequestID: string
  ResponseCode: string
  ResponseDescription: string
  CustomerMessage: string
}

export interface RegisterUrlResponse {
  ResponseCode: string
  ResponseDescription: string
}

/** Both payout rails acknowledge the same way. */
export interface PayoutResponse {
  ConversationID: string
  OriginatorConversationID: string
  ResponseCode: string
  ResponseDescription: string
}

export type B2CResponse = PayoutResponse
export type B2BResponse = PayoutResponse

function timeout(config: DarajaConfig): number {
  return config.timeoutMs ?? DEFAULT_TIMEOUT_MS
}

/**
 * Daraja tokens live 3599s and the token endpoint is itself rate-limited, so
 * they are cached in the store rather than minted per request. The cache is in
 * the database, not in memory: a serverless deployment has no process to hold
 * one.
 */
export async function getAccessToken(config: DarajaConfig, store: BillingStore): Promise<string> {
  const cached = await store.getCachedToken(config.environment, new Date(Date.now() + TOKEN_MARGIN_MS))
  if (cached) return cached.accessToken

  const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64')
  const res = await fetchWithTimeout(
    `${baseUrl(config.environment)}/oauth/v1/generate?grant_type=client_credentials`,
    { method: 'GET', headers: { Authorization: `Basic ${credentials}` } },
    timeout(config),
  )

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Daraja token request failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const body = (await res.json()) as TokenResponse
  if (!body.access_token) throw new Error('Daraja token response contained no access_token')

  const ttlSeconds = Number(body.expires_in)
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 3_599_000

  await store.putCachedToken(config.environment, {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + ttlMs),
  })

  return body.access_token
}

/** Every Daraja error shape we have seen, in one place. */
function darajaError(call: string, status: number, body: DarajaErrorBody): Error {
  const detail = body.errorMessage ?? body.ResponseDescription ?? body.ResultDesc
  return new Error(`Daraja ${call} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`)
}

interface DarajaErrorBody {
  errorCode?: string
  errorMessage?: string
  ResponseDescription?: string
  ResultDesc?: string
}

async function readJson<T>(res: Response): Promise<Partial<T> & DarajaErrorBody> {
  return (await res.json().catch(() => ({}))) as Partial<T> & DarajaErrorBody
}

export interface StkPushParams {
  phoneNumber: string
  amount: Money
  /**
   * Shown on the prompt and the customer's statement. Daraja truncates at 12
   * characters, so a bare UUID is not usable — the payment is attributed by
   * CheckoutRequestID, not by this.
   */
  accountReference: string
  /** Truncated at 13 characters by Daraja. */
  description: string
  /** `CustomerPayBillOnline` for a paybill, `CustomerBuyGoodsOnline` for a till. */
  transactionType?: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
}

export async function stkPush(
  config: DarajaConfig,
  store: BillingStore,
  params: StkPushParams,
): Promise<StkPushResponse> {
  const amount = toDarajaAmount(params.amount)
  const phone = normalisePhone(params.phoneNumber)
  const timestamp = eatTimestamp()
  const token = await getAccessToken(config, store)

  const res = await fetchWithTimeout(
    `${baseUrl(config.environment)}/mpesa/stkpush/v1/processrequest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        BusinessShortCode: config.shortCode,
        Password: stkPassword(config.shortCode, config.passKey, timestamp),
        Timestamp: timestamp,
        TransactionType: params.transactionType ?? 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: config.shortCode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl(config, 'stkCallback'),
        AccountReference: params.accountReference.slice(0, 12),
        TransactionDesc: params.description.slice(0, 13),
      }),
    },
    timeout(config),
  )

  const body = await readJson<StkPushResponse>(res)
  if (!res.ok || body.errorCode || !body.CheckoutRequestID) {
    throw darajaError('STK Push', res.status, body)
  }

  return body as StkPushResponse
}

/**
 * Register the C2B validation and confirmation URLs for the shortcode.
 *
 * `responseType` is what Safaricom does when the validation URL is
 * unreachable. 'Cancelled' rejects the payment, which is the safe default: an
 * unreachable validator means we cannot tell whose payment it is, and an
 * unattributable payment is worse than a declined one. Switch to 'Completed'
 * only if you would rather take the money and reconcile by hand.
 *
 * Re-registering is harmless and is how you move callbacks after a domain
 * change. On production shortcodes Safaricom must activate validation before
 * the validation URL is called at all.
 */
export async function registerC2BUrls(
  config: DarajaConfig,
  store: BillingStore,
  responseType: 'Completed' | 'Cancelled' = 'Cancelled',
): Promise<RegisterUrlResponse> {
  const token = await getAccessToken(config, store)

  const res = await fetchWithTimeout(
    `${baseUrl(config.environment)}/mpesa/c2b/v1/registerurl`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ShortCode: config.shortCode,
        ResponseType: responseType,
        ConfirmationURL: callbackUrl(config, 'c2bConfirmation'),
        ValidationURL: callbackUrl(config, 'c2bValidation'),
      }),
    },
    timeout(config),
  )

  const body = await readJson<RegisterUrlResponse>(res)
  if (!res.ok || body.ResponseCode !== '0') {
    throw darajaError('C2B URL registration', res.status, body)
  }

  return body as RegisterUrlResponse
}

/** Payout rails both need an operator identity Daraja can decrypt. */
function requirePayoutCredentials(config: DarajaConfig, rail: string): {
  initiatorName: string
  securityCredential: string
} {
  const { initiatorName, initiatorPassword, securityCertificate } = config
  if (!initiatorName || !initiatorPassword || !securityCertificate) {
    throw new Error(
      `${rail} requires initiatorName, initiatorPassword and securityCertificate in the Daraja config`,
    )
  }
  return {
    initiatorName,
    securityCredential: securityCredential(initiatorPassword, securityCertificate),
  }
}

export type B2CCommand = 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment'

export interface B2CParams {
  phoneNumber: string
  amount: Money
  remarks: string
  occasion?: string
  /** Default BusinessPayment — a refund, not salary and not a promotion. */
  commandId?: B2CCommand
}

/**
 * Pay out to a customer's phone.
 *
 * Daraja acknowledges the request and reports the real outcome later on the
 * result URL, or on the timeout URL if it expired in the queue. A '0' response
 * here means "accepted for processing", not "paid".
 */
export async function b2cPaymentRequest(
  config: DarajaConfig,
  store: BillingStore,
  params: B2CParams,
): Promise<B2CResponse> {
  const { initiatorName, securityCredential: credential } = requirePayoutCredentials(config, 'B2C')
  const amount = toDarajaAmount(params.amount)
  const token = await getAccessToken(config, store)

  const res = await fetchWithTimeout(
    `${baseUrl(config.environment)}/mpesa/b2c/v1/paymentrequest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        InitiatorName: initiatorName,
        SecurityCredential: credential,
        CommandID: params.commandId ?? 'BusinessPayment',
        Amount: amount,
        PartyA: config.shortCode,
        PartyB: normalisePhone(params.phoneNumber),
        Remarks: params.remarks.slice(0, 100),
        QueueTimeOutURL: callbackUrl(config, 'b2cTimeout'),
        ResultURL: callbackUrl(config, 'b2cResult'),
        Occasion: (params.occasion ?? '').slice(0, 100),
      }),
    },
    timeout(config),
  )

  const body = await readJson<B2CResponse>(res)
  if (!res.ok || body.ResponseCode !== '0' || !body.ConversationID) {
    throw darajaError('B2C request', res.status, body)
  }

  return body as B2CResponse
}

/**
 * What the receiving business is being paid *for*.
 *
 * - `BusinessPayBill` — pay another organisation's paybill. Needs an
 *   `accountReference`: it is the account number on their statement.
 * - `BusinessBuyGoods` — pay a till. No account number.
 * - `DisburseFundsToBusiness` — move funds to a business you control.
 * - `BusinessToBusinessTransfer` — between two shortcodes you control.
 */
export type B2BCommand =
  | 'BusinessPayBill'
  | 'BusinessBuyGoods'
  | 'DisburseFundsToBusiness'
  | 'BusinessToBusinessTransfer'

/** Daraja's identifier types. 4 = paybill, 2 = till. */
export type B2BIdentifierType = '1' | '2' | '4'

export interface B2BParams {
  /** The shortcode being paid — a paybill or till, never a phone number. */
  receiverShortCode: string
  amount: Money
  /**
   * The account number on the receiving organisation's statement. Required by
   * Daraja for `BusinessPayBill`, ignored for `BusinessBuyGoods`.
   */
  accountReference?: string
  remarks: string
  /** Default BusinessPayBill — paying another organisation's paybill. */
  commandId?: B2BCommand
  /** What kind of shortcode is paying. Default 4 (paybill). */
  senderIdentifierType?: B2BIdentifierType
  /** What kind of shortcode is being paid. Default 4 (paybill), 2 for a till. */
  receiverIdentifierType?: B2BIdentifierType
  /**
   * MSISDN of the person on whose behalf you are paying. Optional; Safaricom
   * sends them a confirmation when it is set.
   */
  requesterPhoneNumber?: string
}

/**
 * Pay another business — paybill to paybill, or paybill to till.
 *
 * The shape differs from B2C in three ways that are easy to get wrong, and
 * each fails as an unhelpful generic error:
 *
 * - the operator field is `Initiator`, not `InitiatorName`;
 * - `PartyB` is a shortcode, so it must not go through phone normalisation;
 * - Safaricom's own field is spelled `RecieverIdentifierType`. That typo is
 *   part of the wire format and is reproduced deliberately.
 *
 * Like B2C, a '0' response means "accepted for processing". The outcome
 * arrives on the B2B result URL.
 */
export async function b2bPaymentRequest(
  config: DarajaConfig,
  store: BillingStore,
  params: B2BParams,
): Promise<B2BResponse> {
  const { initiatorName, securityCredential: credential } = requirePayoutCredentials(config, 'B2B')
  const amount = toDarajaAmount(params.amount)
  const receiver = assertShortCode(params.receiverShortCode, 'receiverShortCode')
  const commandId = params.commandId ?? 'BusinessPayBill'

  if (commandId === 'BusinessPayBill' && !params.accountReference?.trim()) {
    throw new Error('BusinessPayBill requires an accountReference — the account number on the receiving paybill')
  }

  const token = await getAccessToken(config, store)

  const payload: Record<string, string | number> = {
    Initiator: initiatorName,
    SecurityCredential: credential,
    CommandID: commandId,
    SenderIdentifierType: params.senderIdentifierType ?? '4',
    RecieverIdentifierType: params.receiverIdentifierType ?? '4',
    Amount: amount,
    PartyA: config.shortCode,
    PartyB: receiver,
    AccountReference: (params.accountReference ?? '').slice(0, 20),
    Remarks: params.remarks.slice(0, 100),
    QueueTimeOutURL: callbackUrl(config, 'b2bTimeout'),
    ResultURL: callbackUrl(config, 'b2bResult'),
  }

  if (params.requesterPhoneNumber) {
    payload['Requester'] = normalisePhone(params.requesterPhoneNumber)
  }

  const res = await fetchWithTimeout(
    `${baseUrl(config.environment)}/mpesa/b2b/v1/paymentrequest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    },
    timeout(config),
  )

  const body = await readJson<B2BResponse>(res)
  if (!res.ok || body.ResponseCode !== '0' || !body.ConversationID) {
    throw darajaError('B2B request', res.status, body)
  }

  return body as B2BResponse
}
