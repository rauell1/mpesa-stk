import { describe, it, expect } from 'vitest'
import {
  baseUrl,
  callbackUrl,
  eatTimestamp,
  normalisePhone,
  stkPassword,
} from '../src/config.js'
import type { DarajaConfig } from '../src/types.js'

// The pure Daraja primitives — the pieces that fail as "invalid credentials"
// rather than as an error that names the real cause.

describe('eatTimestamp', () => {
  it('renders YYYYMMDDHHmmss in EAT (UTC+3), not the host timezone', () => {
    expect(eatTimestamp(new Date('2026-08-25T09:15:30Z'))).toBe('20260825121530')
  })

  it('rolls the date forward when EAT is past midnight but UTC is not', () => {
    expect(eatTimestamp(new Date('2026-08-25T22:30:00Z'))).toBe('20260826013000')
  })

  it('zero-pads every field', () => {
    expect(eatTimestamp(new Date('2026-01-02T00:04:05Z'))).toBe('20260102030405')
  })
})

describe('stkPassword', () => {
  it('is base64(shortcode + passkey + timestamp), in that order', () => {
    const password = stkPassword('174379', 'passkey', '20260825121530')
    expect(Buffer.from(password, 'base64').toString()).toBe('174379passkey20260825121530')
  })
})

describe('normalisePhone', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['712345678', '254712345678'],
    ['0712 345 678', '254712345678'],
    ['+254 (712) 345-678', '254712345678'],
  ])('%s → %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected)
  })

  it.each([
    ['', 'empty'],
    ['0812345678', 'not a 7/1 prefix'],
    ['071234567', 'too short'],
    ['07123456789', 'too long'],
    ['not-a-number', 'no digits'],
  ])('rejects %s (%s)', (input) => {
    expect(() => normalisePhone(input)).toThrow()
  })
})

describe('baseUrl', () => {
  it('points sandbox and live at different hosts', () => {
    expect(baseUrl('sandbox')).toBe('https://sandbox.safaricom.co.ke')
    expect(baseUrl('live')).toBe('https://api.safaricom.co.ke')
  })
})

describe('callbackUrl', () => {
  const config: DarajaConfig = {
    consumerKey: 'k',
    consumerSecret: 's',
    shortCode: '174379',
    passKey: 'p',
    environment: 'sandbox',
    callbackBaseUrl: 'https://app.example.com',
  }

  it('builds the default paths', () => {
    expect(callbackUrl(config, 'stkCallback')).toBe('https://app.example.com/api/webhooks/mpesa')
    expect(callbackUrl(config, 'c2bValidation')).toBe(
      'https://app.example.com/api/webhooks/mpesa/c2b/validation',
    )
  })

  it('does not double the slash when the base URL has a trailing one', () => {
    expect(callbackUrl({ ...config, callbackBaseUrl: 'https://app.example.com/' }, 'stkCallback')).toBe(
      'https://app.example.com/api/webhooks/mpesa',
    )
  })

  it('honours a path override without disturbing the others', () => {
    const overridden: DarajaConfig = { ...config, callbackPaths: { stkCallback: '/hooks/stk' } }
    expect(callbackUrl(overridden, 'stkCallback')).toBe('https://app.example.com/hooks/stk')
    expect(callbackUrl(overridden, 'b2cResult')).toBe(
      'https://app.example.com/api/webhooks/mpesa/b2c/result',
    )
  })
})
