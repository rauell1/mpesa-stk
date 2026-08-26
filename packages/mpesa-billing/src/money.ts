/**
 * Money, stored in minor units.
 *
 * The rails disagree about what "500" means. Daraja takes whole shillings, so
 * `Amount: 500` is KES 500. Stripe takes the smallest currency unit, so
 * `unit_amount: 500` is USD 5.00. Holding both in one `amount` column and
 * hoping the `currency` column is consulted is how a five-dollar payment and a
 * five-hundred-shilling payment become the same number.
 *
 * So a `Money` is always an integer count of minor units plus its currency —
 * KES 500 is `{ currency: 'KES', minor: 50000 }`, USD 5.00 is
 * `{ currency: 'USD', minor: 500 }` — and each rail converts on the way out.
 * Nothing in this package does arithmetic on a float, and no amount crosses a
 * boundary without its currency attached.
 */

/**
 * ISO-4217 currencies whose minor unit is not 1/100. Everything absent from
 * this table has an exponent of 2, which is true of every currency in
 * circulation that is not listed here.
 */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  // Zero-decimal: the minor unit *is* the major unit.
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal.
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

const DEFAULT_EXPONENT = 2

export interface Money {
  /** ISO-4217 alphabetic code, uppercase. */
  currency: string
  /**
   * Integer count of the currency's minor unit — cents for USD, cents for KES,
   * whole yen for JPY. Never fractional, never a float to do arithmetic on.
   */
  minor: number
}

/** Normalise and validate an ISO-4217 code. Throws rather than guessing. */
export function assertCurrency(currency: string): string {
  const code = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`'${currency}' is not an ISO-4217 currency code`)
  }
  return code
}

/** How many decimal places this currency's minor unit represents. */
export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENTS[assertCurrency(currency)] ?? DEFAULT_EXPONENT
}

function assertSafeMinor(minor: number, currency: string): number {
  if (!Number.isInteger(minor)) {
    throw new Error(`${currency} amount must be a whole number of minor units, got ${String(minor)}`)
  }
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`${currency} amount ${String(minor)} exceeds the safe integer range`)
  }
  return minor
}

/** Build a Money from a count of minor units — cents, not shillings. */
export function fromMinor(minor: number, currency: string): Money {
  const code = assertCurrency(currency)
  return { currency: code, minor: assertSafeMinor(minor, code) }
}

/**
 * Build a Money from a major-unit amount: `fromMajor('5.00', 'USD')`,
 * `fromMajor(500, 'KES')`.
 *
 * Strings are parsed digit by digit rather than through `parseFloat`, because
 * `19.99 * 100` is `1998.9999999999998`. A number is accepted for convenience
 * and is stringified first, so it travels the same exact path — which also
 * means a value that has already lost precision as a float is rejected here
 * rather than silently rounded.
 */
export function fromMajor(major: string | number, currency: string): Money {
  const code = assertCurrency(currency)
  const text = typeof major === 'number' ? formatNumberExactly(major, code) : major.trim()

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) throw new Error(`'${String(major)}' is not a valid ${code} amount`)

  const [, sign, whole, fraction = ''] = match as unknown as [string, string, string, string?]
  const exponent = currencyExponent(code)

  if (fraction.length > exponent) {
    // Truncating here would quietly discard the customer's money.
    throw new Error(
      `${code} has ${exponent} decimal place(s); '${String(major)}' has ${fraction.length}`,
    )
  }

  const digits = `${whole}${fraction.padEnd(exponent, '0')}`
  const minor = Number(`${sign}${digits}`)
  return { currency: code, minor: assertSafeMinor(minor, code) }
}

function formatNumberExactly(value: number, currency: string): string {
  if (!Number.isFinite(value)) throw new Error(`'${String(value)}' is not a valid ${currency} amount`)
  // toFixed at the currency's precision, then let fromMajor re-check: a float
  // carrying more precision than the currency has is a caller error.
  const exponent = currencyExponent(currency)
  const fixed = value.toFixed(exponent)
  if (Number(fixed) !== value) {
    throw new Error(
      `${String(value)} cannot be represented exactly in ${currency} (${exponent} decimal places)`,
    )
  }
  return fixed
}

/** Decimal string in major units — `'5.00'`, `'500.00'`, `'1000'` for JPY. */
export function toMajorString(money: Money): string {
  const exponent = currencyExponent(money.currency)
  const negative = money.minor < 0
  const digits = String(Math.abs(money.minor)).padStart(exponent + 1, '0')
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`
  const whole = digits.slice(0, digits.length - exponent)
  const fraction = digits.slice(digits.length - exponent)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/** `'KES 500.00'` — for logs and errors, not for parsing. */
export function formatMoney(money: Money): string {
  return `${money.currency} ${toMajorString(money)}`
}

export function isSameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency
}

export function isEqualMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor
}

/** Add, refusing to mix currencies — the check a plain `+` cannot make. */
export function addMoney(a: Money, b: Money): Money {
  if (!isSameCurrency(a, b)) {
    throw new Error(`Cannot add ${formatMoney(a)} to ${formatMoney(b)}: different currencies`)
  }
  return fromMinor(a.minor + b.minor, a.currency)
}

// ---------------------------------------------------------------------------
// Rail conversions
// ---------------------------------------------------------------------------

/** The only currency Daraja moves. */
export const MPESA_CURRENCY = 'KES'

/**
 * The `Amount` field for any Daraja call: whole shillings, as a number.
 *
 * Daraja rejects a decimal amount, and rejects any currency but KES. Both are
 * checked here rather than at the HTTP boundary, so the error names the real
 * problem instead of arriving as a generic Daraja failure.
 */
export function toDarajaAmount(money: Money): number {
  if (money.currency !== MPESA_CURRENCY) {
    throw new Error(`M-PESA moves ${MPESA_CURRENCY} only; got ${formatMoney(money)}`)
  }
  if (money.minor <= 0) {
    throw new Error(`M-PESA amount must be positive, got ${formatMoney(money)}`)
  }
  if (money.minor % 100 !== 0) {
    throw new Error(`M-PESA amounts are whole shillings; ${formatMoney(money)} has cents`)
  }
  return money.minor / 100
}

/** Parse an amount Safaricom reported (`'500'`, `'500.00'`, `500`) as KES. */
export function darajaAmountToMoney(amount: string | number): Money {
  return fromMajor(typeof amount === 'number' ? amount : amount.trim(), MPESA_CURRENCY)
}

/**
 * Stripe's `unit_amount` — already the minor unit, which is exactly what a
 * Money holds. The conversion is the identity; the function exists so the
 * call site says which convention it is using.
 */
export function toStripeUnitAmount(money: Money): number {
  if (money.minor <= 0) {
    throw new Error(`Stripe amount must be positive, got ${formatMoney(money)}`)
  }
  return money.minor
}

/** Stripe reports `amount_total` in minor units and `currency` in lowercase. */
export function stripeAmountToMoney(amountMinor: number, currency: string): Money {
  return fromMinor(amountMinor, currency)
}

/**
 * Accept either a Money or a `[major, currency]` shorthand at an API boundary.
 * `500` alone is refused: a bare number is the ambiguity this module exists to
 * remove.
 */
export type MoneyInput = Money | { amount: string | number; currency: string }

export function toMoney(input: MoneyInput): Money {
  if ('minor' in input) return fromMinor(input.minor, input.currency)
  return fromMajor(input.amount, input.currency)
}
