import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyStripeSignature } from '../src/stripe.js'

const SECRET = 'whsec_test_secret'
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}'
const NOW = new Date('2026-08-25T12:00:00Z')

function sign(body: string, secret: string, at: Date = NOW): string {
  const t = Math.floor(at.getTime() / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('verifyStripeSignature', () => {
  it('accepts a signature Stripe would have produced', () => {
    expect(verifyStripeSignature(BODY, sign(BODY, SECRET), SECRET, 300, NOW)).toBe(true)
  })

  it('rejects a body that changed after signing — the whole point of the check', () => {
    const header = sign(BODY, SECRET)
    const tampered = BODY.replace('evt_1', 'evt_2')
    expect(verifyStripeSignature(tampered, header, SECRET, 300, NOW)).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    expect(verifyStripeSignature(BODY, sign(BODY, 'whsec_other'), SECRET, 300, NOW)).toBe(false)
  })

  it('rejects a replay of a legitimately signed delivery outside the tolerance', () => {
    const old = new Date(NOW.getTime() - 10 * 60 * 1000)
    expect(verifyStripeSignature(BODY, sign(BODY, SECRET, old), SECRET, 300, NOW)).toBe(false)
  })

  it('accepts one inside the tolerance', () => {
    const recent = new Date(NOW.getTime() - 4 * 60 * 1000)
    expect(verifyStripeSignature(BODY, sign(BODY, SECRET, recent), SECRET, 300, NOW)).toBe(true)
  })

  it('accepts when any v1 matches — endpoint secrets rotate with two live at once', () => {
    const t = Math.floor(NOW.getTime() / 1000)
    const good = createHmac('sha256', SECRET).update(`${t}.${BODY}`).digest('hex')
    const stale = createHmac('sha256', 'whsec_old').update(`${t}.${BODY}`).digest('hex')
    expect(verifyStripeSignature(BODY, `t=${t},v1=${stale},v1=${good}`, SECRET, 300, NOW)).toBe(true)
  })

  it.each([
    ['a missing header', null],
    ['an empty header', ''],
    ['a header with no timestamp', 'v1=abcdef'],
    ['a header with no signature', 't=1'],
    ['a non-numeric timestamp', 't=later,v1=abcdef'],
    ['a v0-only header', 't=1,v0=abcdef'],
  ])('rejects %s', (_label, header) => {
    expect(verifyStripeSignature(BODY, header, SECRET, 300, NOW)).toBe(false)
  })

  it('rejects a signature of the wrong length without throwing', () => {
    const t = Math.floor(NOW.getTime() / 1000)
    expect(verifyStripeSignature(BODY, `t=${t},v1=ab`, SECRET, 300, NOW)).toBe(false)
  })

  it('rejects when no secret is configured, rather than accepting everything', () => {
    expect(verifyStripeSignature(BODY, sign(BODY, SECRET), '', 300, NOW)).toBe(false)
  })
})
