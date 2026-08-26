/**
 * Parsing the payloads Safaricom POSTs back.
 *
 * Modelled on what Daraja actually sends rather than what the docs promise:
 * `CallbackMetadata` is present only on success, item values are missing for
 * fields Safaricom masks (the payer's phone number is masked in 2026+ STK
 * callbacks), `ResultCode` is a number on the STK callback and a string on the
 * C2B ones, and the B2C timeout payload is sometimes flat and sometimes
 * wrapped in `Result`.
 *
 * Every parser is total: it returns null rather than throwing, because a
 * malformed delivery must still be acknowledged, not turned into a 500 that
 * Safaricom retries forever.
 */

export interface CallbackMetadataItem {
  Name: string
  Value?: string | number
}

export interface StkCallbackPayload {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string
      CheckoutRequestID?: string
      ResultCode?: number
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
  amount?: string
}

export function parseStkCallback(raw: unknown): ParsedStkCallback | null {
  const callback = (raw as StkCallbackPayload | null)?.Body?.stkCallback
  if (!callback?.CheckoutRequestID || typeof callback.ResultCode !== 'number') return null

  const items = callback.CallbackMetadata?.Item ?? []
  const item = (name: string): string | undefined => {
    const found = items.find((i) => i?.Name === name)
    return found?.Value === undefined ? undefined : String(found.Value)
  }

  const parsed: ParsedStkCallback = {
    checkoutRequestId: callback.CheckoutRequestID,
    succeeded: callback.ResultCode === 0,
    resultCode: callback.ResultCode,
    resultDesc: callback.ResultDesc ?? '',
  }

  if (callback.MerchantRequestID) parsed.merchantRequestId = callback.MerchantRequestID
  const receipt = item('MpesaReceiptNumber')
  if (receipt) parsed.receipt = receipt
  const phone = item('PhoneNumber')
  if (phone) parsed.phoneNumber = phone
  const amount = item('Amount')
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
  amount: string
  msisdn: string
  payerName?: string
}

export function parseC2B(raw: unknown): ParsedC2B | null {
  const payload = raw as C2BPayload | null
  const reference = payload?.BillRefNumber?.trim()
  if (!payload?.TransID || !reference || payload.TransAmount === undefined) return null

  const parsed: ParsedC2B = {
    transId: payload.TransID,
    reference,
    amount: String(payload.TransAmount),
    msisdn: payload.MSISDN ?? '',
  }

  const name = [payload.FirstName, payload.MiddleName, payload.LastName]
    .filter((part): part is string => Boolean(part))
    .join(' ')
  if (name) parsed.payerName = name

  return parsed
}

export interface B2CResultPayload {
  Result?: {
    ResultType?: number
    ResultCode?: number
    ResultDesc?: string
    OriginatorConversationID?: string
    ConversationID?: string
    TransactionID?: string
    ResultParameters?: { ResultParameter?: Array<{ Key?: string; Value?: string | number }> }
  }
}

export interface ParsedB2CResult {
  conversationId: string
  succeeded: boolean
  resultCode: number
  resultDesc: string
  receipt?: string
}

export function parseB2CResult(raw: unknown): ParsedB2CResult | null {
  const result = (raw as B2CResultPayload | null)?.Result
  if (!result?.ConversationID || typeof result.ResultCode !== 'number') return null

  const parsed: ParsedB2CResult = {
    conversationId: result.ConversationID,
    succeeded: result.ResultCode === 0,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc ?? '',
  }

  if (result.TransactionID) parsed.receipt = result.TransactionID
  return parsed
}

/** The timeout payload has been observed both flat and wrapped in `Result`. */
export interface B2CTimeoutPayload {
  ConversationID?: string
  OriginatorConversationID?: string
  Result?: { ConversationID?: string; OriginatorConversationID?: string; ResultDesc?: string }
}

export function parseB2CTimeout(raw: unknown): { conversationId: string } | null {
  const payload = raw as B2CTimeoutPayload | null
  const conversationId = payload?.ConversationID ?? payload?.Result?.ConversationID
  return conversationId ? { conversationId } : null
}

/** Parse a webhook body without letting malformed JSON become an exception. */
export function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody)
  } catch {
    return null
  }
}
