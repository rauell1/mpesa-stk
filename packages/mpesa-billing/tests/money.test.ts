import { describe, it, expect } from 'vitest'
import {
  addMoney,
  assertCurrency,
  currencyExponent,
  darajaAmountToMoney,
  formatMoney,
  fromMajor,
  fromMinor,
  isEqualMoney,
  stripeAmountToMoney,
  toDarajaAmount,
  toMajorString,
  toMoney,
  toStripeUnitAmount,
} from '../src/money.js'

// The bug this module exists to prevent: "500" meaning KES 500 on one rail and
// USD 5.00 on another, in the same column.

describe('the KES 500 vs USD 5.00 problem', () => {
  const fiveHundredShillings = fromMajor(500, 'KES')
  const fiveDollars = fromMajor('5.00', 'USD')

  it('keeps them apart even though Stripe would call both "500"', () => {
    expect(toStripeUnitAmount(fiveDollars)).toBe(500)
    expect(fiveHundredShillings.minor).toBe(50000)
    expect(isEqualMoney(fiveHundredShillings, fiveDollars)).toBe(false)
  })

  it('sends whole shillings to Daraja and minor units to Stripe', () => {
    expect(toDarajaAmount(fiveHundredShillings)).toBe(500)
    expect(toStripeUnitAmount(fiveDollars)).toBe(500)
  })

  it('formats each back to what a human would recognise', () => {
    expect(formatMoney(fiveHundredShillings)).toBe('KES 500.00')
    expect(formatMoney(fiveDollars)).toBe('USD 5.00')
  })

  it('refuses to add across currencies instead of producing a wrong total', () => {
    expect(() => addMoney(fiveHundredShillings, fiveDollars)).toThrow(/different currencies/)
    expect(addMoney(fiveDollars, fiveDollars)).toEqual({ currency: 'USD', minor: 1000 })
  })
})

describe('fromMajor', () => {
  it.each([
    ['5.00', 'USD', 500],
    ['5', 'USD', 500],
    ['5.4', 'USD', 540],
    ['0.01', 'USD', 1],
    ['19.99', 'USD', 1999],
    ['500', 'KES', 50000],
    ['1000', 'JPY', 1000],
    ['1.234', 'KWD', 1234],
  ])('parses %s %s as %i minor units', (amount, currency, minor) => {
    expect(fromMajor(amount, currency).minor).toBe(minor)
  })

  it('parses decimal strings without float drift', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE-754.
    expect(fromMajor('19.99', 'USD').minor).toBe(1999)
    expect(fromMajor('0.29', 'USD').minor).toBe(29)
    expect(fromMajor('1.005', 'KWD').minor).toBe(1005)
  })

  it('rejects more precision than the currency has, rather than truncating it', () => {
    expect(() => fromMajor('5.005', 'USD')).toThrow(/2 decimal place/)
    expect(() => fromMajor('1000.5', 'JPY')).toThrow(/0 decimal place/)
  })

  it.each(['', 'abc', '5.', '1,000', '1e3', ' '])('rejects %s', (bad) => {
    expect(() => fromMajor(bad, 'USD')).toThrow()
  })

  it('rejects a float that cannot be represented in the currency', () => {
    expect(() => fromMajor(5.005, 'USD')).toThrow(/cannot be represented exactly/)
    expect(() => fromMajor(Number.NaN, 'USD')).toThrow()
  })
})

describe('currencies', () => {
  it('knows the zero-decimal and three-decimal exceptions', () => {
    expect(currencyExponent('JPY')).toBe(0)
    expect(currencyExponent('UGX')).toBe(0)
    expect(currencyExponent('RWF')).toBe(0)
    expect(currencyExponent('KWD')).toBe(3)
    expect(currencyExponent('BHD')).toBe(3)
  })

  it('defaults everything else to two', () => {
    expect(currencyExponent('KES')).toBe(2)
    expect(currencyExponent('USD')).toBe(2)
    expect(currencyExponent('ZAR')).toBe(2)
  })

  it('normalises the code and rejects anything that is not ISO-4217', () => {
    expect(assertCurrency('usd')).toBe('USD')
    expect(assertCurrency(' kes ')).toBe('KES')
    expect(() => assertCurrency('US')).toThrow()
    expect(() => assertCurrency('DOLLAR')).toThrow()
    expect(() => assertCurrency('US1')).toThrow()
  })
})

describe('toMajorString', () => {
  it.each([
    [{ currency: 'USD', minor: 500 }, '5.00'],
    [{ currency: 'USD', minor: 5 }, '0.05'],
    [{ currency: 'USD', minor: 0 }, '0.00'],
    [{ currency: 'KES', minor: 50000 }, '500.00'],
    [{ currency: 'JPY', minor: 1000 }, '1000'],
    [{ currency: 'KWD', minor: 1234 }, '1.234'],
    [{ currency: 'USD', minor: -500 }, '-5.00'],
  ])('renders %o as %s', (money, expected) => {
    expect(toMajorString(money)).toBe(expected)
  })

  it.each([
    ['19.99', 'USD'],
    ['500', 'KES'],
    ['1.234', 'KWD'],
    ['7', 'JPY'],
    ['0.01', 'USD'],
  ])('round-trips %s %s through fromMajor', (amount, currency) => {
    const money = fromMajor(amount, currency)
    expect(fromMajor(toMajorString(money), currency)).toEqual(money)
  })
})

describe('toDarajaAmount', () => {
  it('returns whole shillings', () => {
    expect(toDarajaAmount(fromMajor(500, 'KES'))).toBe(500)
    expect(toDarajaAmount(fromMinor(100, 'KES'))).toBe(1)
  })

  it('refuses any currency but KES — M-PESA moves shillings only', () => {
    expect(() => toDarajaAmount(fromMajor('5.00', 'USD'))).toThrow(/KES only/)
  })

  it('refuses cents, which Daraja rejects with an unhelpful error of its own', () => {
    expect(() => toDarajaAmount(fromMajor('500.50', 'KES'))).toThrow(/whole shillings/)
  })

  it('refuses a non-positive amount', () => {
    expect(() => toDarajaAmount(fromMinor(0, 'KES'))).toThrow(/positive/)
    expect(() => toDarajaAmount(fromMinor(-100, 'KES'))).toThrow(/positive/)
  })
})

describe('provider amounts coming back', () => {
  it('reads what Safaricom reports as KES', () => {
    expect(darajaAmountToMoney('500')).toEqual({ currency: 'KES', minor: 50000 })
    expect(darajaAmountToMoney('500.00')).toEqual({ currency: 'KES', minor: 50000 })
    expect(darajaAmountToMoney(1)).toEqual({ currency: 'KES', minor: 100 })
  })

  it('reads a Stripe amount_total as already-minor units', () => {
    expect(stripeAmountToMoney(500, 'usd')).toEqual({ currency: 'USD', minor: 500 })
    expect(stripeAmountToMoney(1000, 'jpy')).toEqual({ currency: 'JPY', minor: 1000 })
  })
})

describe('toMoney', () => {
  it('accepts either shape at an API boundary', () => {
    expect(toMoney({ amount: '5.00', currency: 'USD' })).toEqual({ currency: 'USD', minor: 500 })
    expect(toMoney({ amount: 500, currency: 'KES' })).toEqual({ currency: 'KES', minor: 50000 })
    expect(toMoney({ minor: 500, currency: 'usd' })).toEqual({ currency: 'USD', minor: 500 })
  })
})

describe('bounds', () => {
  it('rejects a fractional count of minor units', () => {
    expect(() => fromMinor(10.5, 'USD')).toThrow(/whole number of minor units/)
  })

  it('rejects an amount past the safe integer range rather than losing precision', () => {
    expect(() => fromMinor(Number.MAX_SAFE_INTEGER + 2, 'USD')).toThrow(/safe integer/)
  })
})
