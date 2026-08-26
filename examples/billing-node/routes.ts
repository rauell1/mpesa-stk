/**
 * The routes, on two frameworks — the same handlers either way.
 *
 * `mpesa-billing`'s handlers are plain functions over a raw body string, so
 * the framework binding is thin by design. What each binding has to get right
 * is the same short list: raw text (never a parsed body) for Stripe, the
 * provider's own status code, and the caller's real IP.
 */

import express from 'express'
import { createWebhookRoutes } from 'mpesa-billing/next'
import { billing } from './billing.js'

// ---------------------------------------------------------------------------
// Next.js App Router (or any Web-standard runtime: Hono, Bun, workers)
// ---------------------------------------------------------------------------
//
// One file per route, each three lines. The paths must match the callback
// paths in your Daraja config — they are what gets sent to Safaricom, so the
// two cannot be allowed to drift.
//
//   app/api/webhooks/mpesa/route.ts                    → stkCallback
//   app/api/webhooks/mpesa/c2b/validation/route.ts     → c2bValidation
//   app/api/webhooks/mpesa/c2b/confirmation/route.ts   → c2bConfirmation
//   app/api/webhooks/mpesa/b2c/result/route.ts         → b2cResult
//   app/api/webhooks/mpesa/b2c/timeout/route.ts        → b2cTimeout
//   app/api/webhooks/mpesa/b2b/result/route.ts         → b2bResult
//   app/api/webhooks/mpesa/b2b/timeout/route.ts        → b2bTimeout
//   app/api/webhooks/stripe/route.ts                   → stripeWebhook
//
//   // app/api/webhooks/mpesa/b2b/result/route.ts
//   export const runtime = 'nodejs'   // pg and node:crypto are not on edge
//   export const POST = createWebhookRoutes(billing).b2bResult
//
// `sourceIpHeader` only matters if you set `trustedMpesaIps`. Point it at a
// header a proxy *you control* writes — on Vercel 'x-vercel-forwarded-for',
// on Cloudflare 'cf-connecting-ip'. Anywhere else a header is client input,
// and an attacker who can set it can claim to be Safaricom.

export const routes = createWebhookRoutes(billing, { sourceIpHeader: 'x-forwarded-for' })

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

export const app = express()

// express.text keeps the body as the exact bytes the provider signed. A JSON
// body parser in front of the Stripe route breaks signature verification in a
// way that looks like a bad secret.
const rawBody = express.text({ type: '*/*' })

/** Where Express reports the caller's IP; needs `app.set('trust proxy', …)`. */
const sourceIp = (req: express.Request): { sourceIp?: string } =>
  req.ip ? { sourceIp: req.ip } : {}

app.post('/api/webhooks/mpesa', rawBody, async (req, res) => {
  const { reply } = await billing.handleStkCallback(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/mpesa/c2b/validation', rawBody, async (req, res) => {
  const { reply } = await billing.handleC2BValidation(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/mpesa/c2b/confirmation', rawBody, async (req, res) => {
  const { reply } = await billing.handleC2BConfirmation(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/mpesa/b2c/result', rawBody, async (req, res) => {
  const { reply } = await billing.handleB2CResult(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/mpesa/b2c/timeout', rawBody, async (req, res) => {
  const { reply } = await billing.handleB2CTimeout(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/mpesa/b2b/result', rawBody, async (req, res) => {
  const { reply } = await billing.handleB2BResult(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/mpesa/b2b/timeout', rawBody, async (req, res) => {
  const { reply } = await billing.handleB2BTimeout(req.body as string, sourceIp(req))
  res.status(reply.status).json(reply.body)
})

app.post('/api/webhooks/stripe', rawBody, async (req, res) => {
  const { reply } = await billing.handleStripeWebhook(
    req.body as string,
    req.header('stripe-signature') ?? null,
  )
  res.status(reply.status).json(reply.body)
})

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------
//
// Initiation is deliberately not a route this package ships: it is where
// authorization lives, and that cannot be written generically. Whatever
// identifies the payer in your system has to be checked against your session
// before anything is spent against your shortcode.

app.post('/api/pay/mpesa', express.json(), async (req, res) => {
  const { orderId, phoneNumber } = req.body as { orderId: string; phoneNumber: string }

  // if (!(await callerOwnsOrder(req, orderId))) return res.status(403).json({ error: 'Forbidden' })

  const order = await lookUpOrder(orderId)

  const { payment, customerMessage } = await billing.initiateStkPush({
    reference: orderId,
    phoneNumber,
    // Never a bare number: KES 500 is { amount: 500, currency: 'KES' }.
    amount: { minor: order.priceMinor, currency: order.currency },
    // Daraja truncates this at 12 characters and shows it on the customer's
    // statement; the payment is attributed by CheckoutRequestID, not by this.
    accountReference: orderId.slice(0, 12),
    description: 'Order payment',
  })

  res.json({ paymentId: payment.id, checkoutRequestId: payment.providerRef, message: customerMessage })
})

app.post('/api/pay/card', express.json(), async (req, res) => {
  const { orderId } = req.body as { orderId: string }
  const order = await lookUpOrder(orderId)

  // The same order, in a currency Stripe can take. USD 5.00 is
  // { amount: '5.00', currency: 'USD' } — 500 minor units, which is a
  // different quantity from KES 500 and stays distinguishable in storage.
  const { session } = await billing.createStripeCheckout({
    reference: orderId,
    amount: { amount: '5.00', currency: 'USD' },
    successUrl: 'https://app.example.com/orders/success',
    cancelUrl: 'https://app.example.com/orders/cancelled',
    // Reuses the same session on a retry instead of opening a second one.
    idempotencyKey: `checkout:${orderId}`,
  })

  res.json({ url: session.url })
})

/** Pay a supplier's paybill. */
app.post('/api/payouts/business', express.json(), async (req, res) => {
  const { invoiceId, supplierShortCode, theirAccountNumber, amountKes } = req.body as {
    invoiceId: string
    supplierShortCode: string
    theirAccountNumber: string
    amountKes: number
  }

  const { payment } = await billing.initiateB2B({
    reference: invoiceId,
    receiverShortCode: supplierShortCode,
    amount: { amount: amountKes, currency: 'KES' },
    // Required for BusinessPayBill: the account number on their statement.
    accountReference: theirAccountNumber,
    remarks: `Invoice ${invoiceId}`,
  })

  // PENDING, always. Daraja acknowledges the request and reports the outcome
  // later on the B2B result URL — a '0' here means "accepted", not "paid".
  res.json({ paymentId: payment.id, conversationId: payment.providerRef, status: payment.status })
})

/** Refund a customer to their phone. */
app.post('/api/payouts/refund', express.json(), async (req, res) => {
  const { orderId, phoneNumber, amountKes } = req.body as {
    orderId: string
    phoneNumber: string
    amountKes: number
  }

  const { payment } = await billing.initiateB2C({
    reference: orderId,
    phoneNumber,
    amount: { amount: amountKes, currency: 'KES' },
    remarks: `Refund for ${orderId}`,
  })

  res.json({ paymentId: payment.id, status: payment.status })
})

declare function lookUpOrder(id: string): Promise<{ priceMinor: number; currency: string }>
