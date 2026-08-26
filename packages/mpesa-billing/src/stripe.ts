/**
 * Stripe Checkout, without the SDK.
 *
 * Two calls are all this rail needs — create a session, verify a webhook — and
 * both are a few lines against documented HTTP. Keeping the SDK out means this
 * package has no dependency to keep in step with the host app's own Stripe
 * version, and no pinned `apiVersion` to drift.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { fetchWithTimeout } from './config.js'
import { fromMinor, toMajorString, toStripeUnitAmount, type Money } from './money.js'
import type { StripeConfig } from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TOLERANCE_SECONDS = 300

export interface CheckoutSessionParams {
  /** Your identifier for what is being paid for; echoed back on the webhook. */
  reference: string
  /**
   * What to charge, currency attached. Converted to Stripe's `unit_amount`
   * here, so the caller never has to remember whether this rail counts cents
   * or dollars.
   */
  amount: Money
  productName?: string
  successUrl: string
  cancelUrl: string
  /** Reuses the same session for a retried request instead of opening a second one. */
  idempotencyKey?: string
  /** Extra metadata to attach; `reference` is always included. */
  metadata?: Record<string, string>
}

export interface CheckoutSession {
  id: string
  url: string
}

export async function createCheckoutSession(
  config: StripeConfig,
  params: CheckoutSessionParams,
): Promise<CheckoutSession> {
  const unitAmount = toStripeUnitAmount(params.amount)
  // Stripe wants the code lowercase; a Money always holds it uppercase.
  const currency = params.amount.currency.toLowerCase()

  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][product_data][name]': params.productName ?? params.reference,
    'line_items[0][price_data][unit_amount]': String(unitAmount),
    'line_items[0][quantity]': '1',
    // client_reference_id is what the webhook reads; the metadata copy is what
    // a human reads in the dashboard during a dispute.
    client_reference_id: params.reference,
    'metadata[reference]': params.reference,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  })

  for (const [key, value] of Object.entries(params.metadata ?? {})) {
    form.set(`metadata[${key}]`, value)
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey

  const res = await fetchWithTimeout(
    'https://api.stripe.com/v1/checkout/sessions',
    { method: 'POST', headers, body: form.toString() },
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )

  const body = (await res.json().catch(() => ({}))) as {
    id?: string
    url?: string
    error?: { message?: string }
  }

  if (!res.ok || !body.id || !body.url) {
    throw new Error(
      `Stripe Checkout session creation failed (HTTP ${res.status})${body.error?.message ? `: ${body.error.message}` : ''}`,
    )
  }

  return { id: body.id, url: body.url }
}

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * The signature is computed over `${timestamp}.${rawBody}` — the *raw* bytes.
 * Parsing the body to JSON and re-serialising it changes key order and
 * whitespace, and the check then fails for reasons that look like a bad
 * secret. Read the body as text and pass it here untouched.
 *
 * Returns false rather than throwing: a bad signature is an expected event on
 * a public endpoint, not an exception.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  now: Date = new Date(),
): boolean {
  if (!signatureHeader || !secret) return false

  let timestamp: string | undefined
  const signatures: string[] = []

  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.trim().split('=', 2)
    if (!value) continue
    if (key === 't') timestamp = value
    // v1 can appear more than once while an endpoint secret is being rotated.
    else if (key === 'v1') signatures.push(value)
  }

  if (!timestamp || signatures.length === 0) return false

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) return false

  // Reject replays of an old, legitimately signed delivery.
  const ageSeconds = Math.abs(now.getTime() / 1000 - timestampSeconds)
  if (toleranceSeconds > 0 && ageSeconds > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()

  return signatures.some((candidate) => {
    let provided: Buffer
    try {
      provided = Buffer.from(candidate, 'hex')
    } catch {
      return false
    }
    // timingSafeEqual throws on a length mismatch, which is itself a comparison.
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  })
}

export interface StripeCheckoutSessionObject {
  id: string
  client_reference_id?: string | null
  payment_intent?: string | { id?: string } | null
  payment_status?: string
  amount_total?: number | null
  currency?: string | null
  customer?: string | { id?: string } | null
  metadata?: Record<string, string> | null
}

export interface StripeEvent {
  id: string
  type: string
  data: { object: StripeCheckoutSessionObject }
}

/** The reference a session carries, from either of the two places we set it. */
export function sessionReference(session: StripeCheckoutSessionObject): string | undefined {
  return session.client_reference_id ?? session.metadata?.['reference'] ?? undefined
}

export function sessionPaymentIntentId(session: StripeCheckoutSessionObject): string | undefined {
  const intent = session.payment_intent
  if (typeof intent === 'string') return intent
  return intent?.id ?? undefined
}

/**
 * What the session actually collected, as a Money.
 *
 * `amount_total` is in the smallest currency unit and `currency` is lowercase,
 * which is exactly a Money once the code is upper-cased — no scaling, and no
 * chance of reading 500 as five hundred dollars.
 */
export function sessionAmount(session: StripeCheckoutSessionObject): Money | undefined {
  const { amount_total: total, currency } = session
  if (typeof total !== 'number' || !currency) return undefined
  try {
    return fromMinor(total, currency)
  } catch {
    return undefined
  }
}

/** `'5.00'` from a session, for a receipt line. */
export function sessionAmountMajor(session: StripeCheckoutSessionObject): string | undefined {
  const money = sessionAmount(session)
  return money ? toMajorString(money) : undefined
}
