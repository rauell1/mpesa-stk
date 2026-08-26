/**
 * Daraja HTTP calls: OAuth, STK Push, C2B URL registration, B2C payouts.
 *
 * These are the outbound half. The inbound half — what Safaricom POSTs back —
 * lives in callbacks.ts.
 */

import {
  assertWholeAmount,
  baseUrl,
  callbackUrl,
  eatTimestamp,
  fetchWithTimeout,
  normalisePhone,
  securityCredential,
  stkPassword,
} from './config.js'
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

export interface B2CResponse {
  ConversationID: string
  OriginatorConversationID: string
  ResponseCode: string
  ResponseDescription: string
}

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

export interface StkPushParams {
  phoneNumber: string
  amount: number
  /**
   * Shown on the prompt and the customer's statement. Daraja truncates at 12
   * characters, so a bare UUID is not usable — the payment is attributed by
   * CheckoutRequestID, not by this.
   */
  accountReference: string
  /** Truncated at 13 characters by Daraja. */
  description: string
}

export async function stkPush(
  config: DarajaConfig,
  store: BillingStore,
  params: StkPushParams,
): Promise<StkPushResponse> {
  const amount = assertWholeAmount(params.amount)
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
        TransactionType: 'CustomerPayBillOnline',
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

  const body = (await res.json().catch(() => ({}))) as Partial<StkPushResponse> & {
    errorCode?: string
    errorMessage?: string
  }

  if (!res.ok || body.errorCode || !body.CheckoutRequestID) {
    throw new Error(
      `Daraja STK Push failed (HTTP ${res.status})${body.errorMessage ? `: ${body.errorMessage}` : ''}`,
    )
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

  const body = (await res.json().catch(() => ({}))) as Partial<RegisterUrlResponse> & {
    errorMessage?: string
  }

  if (!res.ok || body.ResponseCode !== '0') {
    const detail = body.errorMessage ?? body.ResponseDescription
    throw new Error(`C2B URL registration failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
  }

  return body as RegisterUrlResponse
}

export type B2CCommand = 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment'

export interface B2CParams {
  phoneNumber: string
  amount: number
  remarks: string
  occasion?: string
  /** Default BusinessPayment — a refund, not salary and not a promotion. */
  commandId?: B2CCommand
}

/**
 * Daraja acknowledges a payout request and reports the real outcome later on
 * the result URL, or on the timeout URL if it expired in the queue. A '0'
 * response here means "accepted for processing", not "paid".
 */
export async function b2cPaymentRequest(
  config: DarajaConfig,
  store: BillingStore,
  params: B2CParams,
): Promise<B2CResponse> {
  const { initiatorName, initiatorPassword, securityCertificate } = config
  if (!initiatorName || !initiatorPassword || !securityCertificate) {
    throw new Error(
      'B2C requires initiatorName, initiatorPassword and securityCertificate in the Daraja config',
    )
  }

  const amount = assertWholeAmount(params.amount)
  const token = await getAccessToken(config, store)

  const res = await fetchWithTimeout(
    `${baseUrl(config.environment)}/mpesa/b2c/v1/paymentrequest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential(initiatorPassword, securityCertificate),
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

  const body = (await res.json().catch(() => ({}))) as Partial<B2CResponse> & {
    errorMessage?: string
  }

  if (!res.ok || body.ResponseCode !== '0' || !body.ConversationID) {
    const detail = body.errorMessage ?? body.ResponseDescription
    throw new Error(`Daraja B2C request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
  }

  return body as B2CResponse
}
