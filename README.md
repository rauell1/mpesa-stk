# mpesa-stk

M-PESA for TypeScript, in two packages you can use separately or together.

| Package | Covers | Use it when |
|---|---|---|
| **`mpesa-stk`** (this one) | STK Push, end to end | You need the STK lifecycle done properly — idempotency, dedup, a poll fallback, reconciliation, a signing relay |
| **[`mpesa-billing`](./packages/mpesa-billing/)** | STK Push, C2B, B2C, B2B, Stripe Checkout | You need more than one rail, settling through one exactly-once contract |

Node 18+ · Postgres · zero-config TypeScript types. Start with `mpesa-billing` if you
want the other rails; everything below is `mpesa-stk` itself.

---

The M-Pesa STK Push lifecycle, done properly. Daraja gives you "send a push" and "receive one callback" — this library is everything in between: idempotent initiation, atomic callback dedup, a polling fallback, and reconciliation.

TypeScript · Node 18+ · Postgres. STK Push only — for B2C, C2B, B2B, or cards, use [`mpesa-billing`](./packages/mpesa-billing/).

## Why

Daraja's docs are a request/response spec. They stop where production starts. Pointed at the live sandbox, the API actually:

- re-fires the same callback multiple times under load — dedupe or you double-credit
- drops the callback entirely if your server blinks — no retry, no dead-letter
- rate-limits the STK Query (5 req/min in sandbox) and returns undocumented transient codes like `4999` mid-flight — a naive poller marks a still-pending payment FAILED
- masks the customer's phone number in 2026+ callbacks
- has no idempotency key — a double-tapped "Pay" sends two pushes and charges twice

Each of those is a wrong refund or a missed order waiting to happen. This library is that missing layer.

## Install

```bash
npm install mpesa-stk pg
```

## Usage

```typescript
import { MpesaStk, PostgresAdapter } from 'mpesa-stk'
import { Pool } from 'pg'

const adapter = new PostgresAdapter(new Pool({ connectionString: process.env.DATABASE_URL }))
await adapter.migrate() // creates mpesa_payments; safe on every startup (IF NOT EXISTS)

const mpesa = new MpesaStk(
  {
    consumerKey:    process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortCode:      process.env.MPESA_SHORTCODE!,
    passKey:        process.env.MPESA_PASSKEY!,
    callbackUrl:    process.env.MPESA_CALLBACK_URL!,
    environment:    'sandbox',
  },
  adapter
)

// Fires once when a payment reaches a terminal state — via callback or poll
mpesa.onPaymentSettled(async (p) => console.log(p.id, p.status, p.mpesaReceiptNumber))

// idempotencyKey makes a retried/double-tapped request safe
const payment = await mpesa.initiatePayment({
  phoneNumber: '0712345678',
  amount: 500,
  accountReference: 'ORDER-123',
  description: 'Payment for ORDER-123',
  idempotencyKey: 'ORDER-123',
})

// Webhook route — ACK Safaricom first (within 5s), then process
app.post('/mpesa/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Success' })
  await mpesa.processCallback(req.body)
})

// Reconcile on a schedule, not per request
await mpesa.reconcile(new Date(Date.now() - 864e5), new Date(Date.now() - 3e5))
```

Config: `timeoutMs` (75000), `pollIntervalMs` (5000 — base of the poll backoff), `maxPollAttempts` (10).

## How it works

- **Callback dedup** — `settlePayment` is one SQL compare-and-swap (`UPDATE … WHERE status = 'PENDING'`), not a read-then-check. Exactly one of N racing callbacks wins; `onPaymentSettled` fires once. The same guard covers poll-vs-callback.
- **Idempotent initiation** — concurrent same-key calls share one in-flight STK Push; across processes, a `UNIQUE` constraint on the key (written in the same `INSERT` as the record) is the backstop.
- **Poll fallback** — Fibonacci backoff from `pollIntervalMs` (5s → 10s → 15s → 25s → 30s), checks storage before each query, and settles only on a *known-terminal* code — transient/unknown codes keep waiting instead of failing a live payment.
- **Reconciliation** — checks every status, not just PENDING, because drift runs both ways:

| Your record | Daraja STK Query | What it means | `reconcile` result |
|---|---|---|---|
| `PENDING` | `SUCCESS` | callback + poll both missed it; customer paid | mismatch |
| `TIMEOUT` / `FAILED` | `SUCCESS` | you gave up or wrote it off, but money moved — the dangerous one (you may refund a paid order) | mismatch |
| `SUCCESS` | a failure code | a recorded success Daraja contradicts | mismatch |
| `SUCCESS` | no record / query error | possible ghost credit or spoofed callback | skipped (unverifiable) |
| any | transient `4999` / `429` | not yet determinable | skipped (re-run) |

Mismatches are returned, never auto-corrected — a stale query during a manual reversal would otherwise credit the wrong order. `reconcile` only settles drift it can *prove*; anything it can't verify is `skipped`, not guessed.

More depth: [why callbacks fail](./docs/why-callbacks-fail.md) · [reconciliation](./docs/reconciliation.md) · [unverified Daraja behaviors](./tests/integration/UNVERIFIED_BEHAVIORS.md).

## Relay (optional)

Point Safaricom's `CallbackURL` at the relay instead of your app. It dedupes, persists, and redelivers one signed webhook with backoff (→ 30s → 2m → 10m → 30m → 2h → dead-letter), so a restart never loses a callback.

```bash
DATABASE_URL=… PORT=3000 npx mpesa-stk-relay
```

Safaricom doesn't sign callbacks; the relay does. Verify it, or anyone with your URL can POST fake successes:

```typescript
import { verifySignature } from 'mpesa-stk/server'

if (!verifySignature(rawBody, process.env.MPESA_RELAY_SECRET!, sig)) return res.status(401).end()
```

Embedding, registration, and delivery-status endpoints: [examples/](./examples/).

## Examples

- [Next.js App Router](./examples/nextjs/) — STK Push with `mpesa-stk`
- [Express](./examples/express/server.ts) — STK Push with `mpesa-stk`
- [All rails](./examples/billing-node/) — STK, C2B, B2C, B2B and Stripe with `mpesa-billing`

## Also in this repo

**[`mpesa-billing`](./packages/mpesa-billing/)** — a sibling package covering five rails with one settlement contract: STK Push, C2B, B2C, B2B, and Stripe Checkout. It handles the three M-Pesa rails this library deliberately leaves out, plus a card rail, and gives them all the same exactly-once guard. Every amount carries its currency in minor units, so KES 500 and USD 5.00 stay distinguishable end to end. It has no poll fallback and no reconciliation, so for STK Push alone this library is the better tool. Use both together: this library for the STK lifecycle, `mpesa-billing`'s `applyOnSettle` for whatever a settled payment should cause.

[examples/billing-node](./examples/billing-node/) shows it wired into a project, on Next.js and Express.

MIT
