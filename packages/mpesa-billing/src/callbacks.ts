/**
 * Parsing the payloads Safaricom POSTs back.
 *
 * Modelled on what Daraja actually sends rather than what the docs promise:
 * `CallbackMetadata` is present only on success, item values are missing for
 * fields Safaricom masks (the payer's phone number is masked in 2026+ STK
 * callbacks), `ResultCode` is a number on the STK callback and a string on the
 * C2B ones, and the payout timeout payload is sometimes flat and sometimes
 * wrapped in `Result`.
 *
 * Every parser is total: it returns null rather than throwing, because a
 * malformed delivery must still be acknowledged, not turned into a 500 that
 * Safaricom retries forever.
 */

import { darajaAmountToMoney } from './money.js'
import type { Money } from './money.js'

export interface CallbackMetadataItem {
  Name: string
  Value?: string | number
}

export interface StkCallbackPayload {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string
      CheckoutRequestID?: string
      ResultCode?: number | string
      ResultDesc?: string
      CallbackMetadata?: { Item?: CallbackMetadataItem[] }
    }
  }
}

export interface ParsedStkCallback {
  checkoutRequestId: string
  merchantRequestId?: string
  succeeded: boolean
  resultCode: number
  resultDesc: string
  receipt?: string
  phoneNumber?: string
  /** What Safaricom says was actually paid. Present on success only. */
  amount?: Money
}

/**
 * `ResultCode` arrives as a number on most deliveries and as a string on some;
 * both mean the same thing, and only `0` is success.
 */
function resultCodeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** Never let a malformed amount lose the whole callback — the receipt matters more. */
function moneyOrUndefined(amount: string | number | undefined): Money | undefined {
  if (amount === undefined || amount === '') return undefined
  try {
    return darajaAmountToMoney(amount)
  } catch {
    return undefined
  }
}

export function parseStkCallback(raw: unknown): ParsedStkCallback | null {
  const callback = (raw as StkCallbackPayload | null)?.Body?.stkCallback
  const resultCode = resultCodeOf(callback?.ResultCode)
  if (!callback?.CheckoutRequestID || resultCode === null) return null

  const items = callback.CallbackMetadata?.Item ?? []
  const item = (name: string): string | undefined => {
    const found = items.find((i) => i?.Name === name)
    return found?.Value === undefined ? undefined : String(found.Value)
  }

  const parsed: ParsedStkCallback = {
    checkoutRequestId: callback.CheckoutRequestID,
    succeeded: resultCode === 0,
    resultCode,
    resultDesc: callback.ResultDesc ?? '',
  }

  if (callback.MerchantRequestID) parsed.merchantRequestId = callback.MerchantRequestID
  const receipt = item('MpesaReceiptNumber')
  if (receipt) parsed.receipt = receipt
  const phone = item('PhoneNumber')
  if (phone) parsed.phoneNumber = phone
  const amount = moneyOrUndefined(item('Amount'))
  if (amount) parsed.amount = amount

  return parsed
}

/** Payload Safaricom POSTs to both the C2B validation and confirmation URLs. */
export interface C2BPayload {
  TransactionType?: string
  TransID?: string
  TransTime?: string
  TransAmount?: string | number
  BusinessShortCode?: string
  BillRefNumber?: string
  InvoiceNumber?: string
  OrgAccountBalance?: string
  ThirdPartyTransID?: string
  MSISDN?: string
  FirstName?: string
  MiddleName?: string
  LastName?: string
}

export interface ParsedC2B {
  transId: string
  /** The account number the customer typed — your reference. */
  reference: string
  amount: Money
  msisdn: string
  payerName?: string
}

export function parseC2B(raw: unknown): ParsedC2B | null {
  const payload = raw as C2BPayload | null
  const reference = payload?.BillRefNumber?.trim()
  if (!payload?.TransID || !reference || payload.TransAmount === undefined) return null

  // Unlike the STK amount, this one is load-bearing: C2B has no prior record,
  // so an unparseable amount would be recorded as a payment of nothing.
  const amount = moneyOrUndefined(payload.TransAmount)
  if (!amount) return null

  const parsed: ParsedC2B = {
    transId: payload.TransID,
    reference,
    amount,
    msisdn: payload.MSISDN ?? '',
  }

  const name = [payload.FirstName, payload.MiddleName, payload.LastName]
    .filter((part): part is string => Boolean(part))
    .join(' ')
  if (name) parsed.payerName = name

  return parsed
}

// ---------------------------------------------------------------------------
// Payout results — B2C and B2B share the `Result` envelope
// ---------------------------------------------------------------------------

export interface ResultParameter {
  Key?: string
  Value?: string | number
}

export interface PayoutResultPayload {
  Result?: {
    ResultType?: number | string
    ResultCode?: number | string
    ResultDesc?: string
    OriginatorConversationID?: string
    ConversationID?: string
    TransactionID?: string
    ResultParameters?: { ResultParameter?: ResultParameter[] | ResultParameter }
  }
}

export interface ParsedPayoutResult {
  conversationId: string
  originatorConversationId?: string
  succeeded: boolean
  resultCode: number
  resultDesc: string
  receipt?: string
  /** What Safaricom says actually left the account. */
  amount?: Money
  /** `254712345678 - JOHN DOE`, as Safaricom formats it. */
  receiverName?: string
  /** Every ResultParameter, flattened — the fields this package does not model. */
  parameters: Record<string, string>
}

/**
 * `ResultParameter` is an array on a multi-field result and a bare object when
 * Safaricom has exactly one to report. Both shapes appear in production.
 */
function flattenResultParameters(
  block: { ResultParameter?: ResultParameter[] | ResultParameter } | undefined,
): Record<string, string> {
  const raw = block?.ResultParameter
  if (!raw) return {}
  const list = Array.isArray(raw) ? raw : [raw]

  const parameters: Record<string, string> = {}
  for (const entry of list) {
    if (!entry?.Key || entry.Value === undefined || entry.Value === null) continue
    parameters[entry.Key] = String(entry.Value)
  }
  return parameters
}

/**
 * Parse a B2C or B2B result callback.
 *
 * The receipt and the amount that actually moved live in `ResultParameters`,
 * not on the `Result` itself — B2C names them `TransactionReceipt` and
 * `TransactionAmount`, B2B names them `TransactionID`/`Amount`. Reading only
 * `Result.TransactionID` records a payout without ever recording what it paid.
 */
export function parsePayoutResult(raw: unknown): ParsedPayoutResult | null {
  const result = (raw as PayoutResultPayload | null)?.Result
  const resultCode = resultCodeOf(result?.ResultCode)
  if (!result?.ConversationID || resultCode === null) return null

  const parameters = flattenResultParameters(result.ResultParameters)

  const parsed: ParsedPayoutResult = {
    conversationId: result.ConversationID,
    succeeded: resultCode === 0,
    resultCode,
    resultDesc: result.ResultDesc ?? '',
    parameters,
  }

  if (result.OriginatorConversationID) {
    parsed.originatorConversationId = result.OriginatorConversationID
  }

  const receipt =
    parameters['TransactionReceipt'] ?? parameters['TransactionID'] ?? result.TransactionID
  if (receipt) parsed.receipt = receipt

  const amount = moneyOrUndefined(parameters['TransactionAmount'] ?? parameters['Amount'])
  if (amount) parsed.amount = amount

  const receiverName = parameters['ReceiverPartyPublicName']
  if (receiverName) parsed.receiverName = receiverName

  return parsed
}

/** @deprecated Use {@link parsePayoutResult} — B2C and B2B share one envelope. */
export const parseB2CResult = parsePayoutResult

/** The timeout payload has been observed both flat and wrapped in `Result`. */
export interface PayoutTimeoutPayload {
  ConversationID?: string
  OriginatorConversationID?: string
  Result?: { ConversationID?: string; OriginatorConversationID?: string; ResultDesc?: string }
}

export function parsePayoutTimeout(raw: unknown): { conversationId: string } | null {
  const payload = raw as PayoutTimeoutPayload | null
  const conversationId = payload?.ConversationID ?? payload?.Result?.ConversationID
  return conversationId ? { conversationId } : null
}

/** @deprecated Use {@link parsePayoutTimeout}. */
export const parseB2CTimeout = parsePayoutTimeout

/** Parse a webhook body without letting malformed JSON become an exception. */
export function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return null
  }
}
