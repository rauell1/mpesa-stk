export { Billing } from './billing.js'
export type { BillingOptions, SettledHandler } from './billing.js'

export type {
  ApplyInTransaction,
  BillingStore,
  CachedToken,
  SettleUpdates,
} from './adapters/types.js'

export type {
  BillingPayment,
  CallbackPaths,
  DarajaConfig,
  Logger,
  MpesaEnvironment,
  PaymentStatus,
  Rail,
  StripeConfig,
  WebhookContext,
  WebhookReply,
  WebhookResult,
} from './types.js'
export { DEFAULT_CALLBACK_PATHS, PAYOUT_RAILS, RAILS, isPayoutRail } from './types.js'

// Money — every amount that crosses a boundary carries its currency.
export {
  MPESA_CURRENCY,
  addMoney,
  assertCurrency,
  currencyExponent,
  darajaAmountToMoney,
  formatMoney,
  fromMajor,
  fromMinor,
  isEqualMoney,
  isSameCurrency,
  stripeAmountToMoney,
  toDarajaAmount,
  toMajorString,
  toMoney,
  toStripeUnitAmount,
} from './money.js'
export type { Money, MoneyInput } from './money.js'

export {
  SAFARICOM_CALLBACK_CIDRS,
  assertShortCode,
  baseUrl,
  callbackPaths,
  callbackUrl,
  darajaConfigFromEnv,
  eatTimestamp,
  isIpAllowed,
  normalisePem,
  normalisePhone,
  securityCredential,
  stkPassword,
  stripeConfigFromEnv,
} from './config.js'

export {
  parseC2B,
  parsePayoutResult,
  parsePayoutTimeout,
  parseStkCallback,
  // Kept as aliases so existing imports keep working.
  parseB2CResult,
  parseB2CTimeout,
} from './callbacks.js'
export type {
  ParsedC2B,
  ParsedPayoutResult,
  ParsedStkCallback,
  ResultParameter,
} from './callbacks.js'

export { b2bPaymentRequest, b2cPaymentRequest, getAccessToken, registerC2BUrls, stkPush } from './daraja.js'
export type {
  B2BCommand,
  B2BIdentifierType,
  B2BParams,
  B2BResponse,
  B2CCommand,
  B2CParams,
  B2CResponse,
  PayoutResponse,
  RegisterUrlResponse,
  StkPushParams,
  StkPushResponse,
} from './daraja.js'

export {
  createCheckoutSession,
  sessionAmount,
  sessionAmountMajor,
  sessionPaymentIntentId,
  sessionReference,
  verifyStripeSignature,
} from './stripe.js'
export type { CheckoutSession, CheckoutSessionParams, StripeEvent } from './stripe.js'
