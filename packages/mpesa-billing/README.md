# mpesa-billing

M-PESA and Stripe payment rails with one settlement contract, portable across projects.

Four rails — STK Push, C2B, B2C, Stripe Checkout — that all end the same way: exactly one delivery settles a payment, and exactly one gets to act on it. Zero runtime dependencies; `pg` is an optional peer for the Postgres store.

TypeScript · Node 18+ · Postgres (or your own store).

## Why this exists separately

Payment providers redeliver. Daraja re-fires the STK callback under load and gives you no idempotency key; Stripe retries any non-2xx for three days. A handler that reads a row, checks its status, then writes will credit one payment twice the first time two deliveries land together — and that is a refund you make by hand, or an order you ship twice.

Getting that right is the same work in every project, so it lives here rather than being re-typed per app.

## Install

```bash
npm install mpesa-billing pg
```

## Use

```typescript
import { Billing } from 'mpesa-billing'
import { PostgresStore } from 'mpesa-billing/adapters/postgres'
import { Pool } from 'pg'

const store = new PostgresStore(new Pool({ connectionString: process.env.DATABASE_URL }))
await store.migrate() // billing_payments + billing_mpesa_tokens; safe on every startup

const billing = new Billing({
  store,
  mpesa: {
    consumerKey:     process.env.MPESA_CONSUMER_KEY!,
    consumerSecret:  process.env.MPESA_CONSUMER_SECRET!,
    shortCode:       process.env.MPESA_SHORTCODE!,
    passKey:         process.env.MPESA_PASSKEY!,
    environment:     'sandbox',
    callbackBaseUrl: 'https://app.example.com',
  },
  stripe: {
    secretKey:     process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  },
  // Runs inside the settlement transaction — see "Acting on a payment" below.
  applyOnSettle: async (payment, tx) => {
    if (payment.status !== 'SUCCESS') return
    await (tx as PoolClient).query('UPDATE orders SET paid = true WHERE id = $1', [payment.reference])
  },
  // C2B: the only gate before Safaricom moves the customer's money.
  validateC2BReference: async (reference) => orderExists(reference),
})

const { payment, customerMessage } = await billing.initiateStkPush({
  reference:   'ORDER-42',        // your id — this is what comes back on settlement
  phoneNumber: '0712345678',
  amount:      500,
})
```

`reference` is the whole portability story: an order number, an organization id, a user id — whatever the payment is *for* in your system. This package never interprets it.

## Webhook routes (Next.js App Router)

```typescript
// app/api/webhooks/mpesa/route.ts
import { createWebhookRoutes } from 'mpesa-billing/next'
import { billing } from '@/lib/billing'

export const runtime = 'nodejs'
export const POST = createWebhookRoutes(billing).stkCallback
```

The six handlers map to the six default paths:

| Route | Handler | Called by |
|---|---|---|
| `/api/webhooks/mpesa` | `stkCallback` | Safaricom |
| `/api/webhooks/mpesa/c2b/validation` | `c2bValidation` | Safaricom |
| `/api/webhooks/mpesa/c2b/confirmation` | `c2bConfirmation` | Safaricom |
| `/api/webhooks/mpesa/b2c/result` | `b2cResult` | Safaricom |
| `/api/webhooks/mpesa/b2c/timeout` | `b2cTimeout` | Safaricom |
| `/api/webhooks/stripe` | `stripeWebhook` | Stripe |

Different paths? Set `callbackPaths` on the Daraja config — the URLs sent to Safaricom are built from it, so the two cannot drift.

Not on Next? The handlers are plain `(Request) => Response`, so they work in Hono, Bun, or any Web-standard runtime. On Express, or anywhere else, call the framework-agnostic methods directly — each takes the raw body string and returns `{ reply: { status, body }, settled, duplicate }`:

```typescript
app.post('/api/webhooks/mpesa', express.text({ type: '*/*' }), async (req, res) => {
  const { reply } = await billing.handleStkCallback(req.body)
  res.status(reply.status).json(reply.body)
})
```

## How settlement works

Settlement is a **compare-and-swap**, never a read-then-check:

```sql
UPDATE billing_payments
   SET status = 'SUCCESS', receipt = $1, settled_at = now()
 WHERE rail = 'stk' AND provider_ref = $2 AND status = 'PENDING'   -- ← the guard
RETURNING *
```

Exactly one of N racing deliveries gets a row back. C2B has no prior row — the money moves before you hear about it — so it uses the same guard as `INSERT … ON CONFLICT (rail, provider_ref) DO NOTHING … RETURNING`, where the UNIQUE constraint on Safaricom's receipt makes a replay a no-op.

Either way, the winner is the record returned as `settled`. A `null` means the delivery was a duplicate, or was for a payment you never issued.

### Acting on a payment

Two hooks, and the difference matters:

- **`applyOnSettle(payment, tx)`** runs *inside* the settlement transaction, on the winning delivery only. Throwing rolls the settlement back with it. Use it for anything that must be atomic with recording the payment: granting a plan, marking an order paid, releasing stock.
- **`onPaymentSettled(payment)`** runs after the commit. A throwing listener is logged and swallowed — it must not turn into a non-200 that makes the provider redeliver a payment you have already committed. Use it for work that may lag: receipts, notifications, analytics.

### Replying to the provider

The two providers want opposite things, and following the wrong convention is itself a bug:

- **Safaricom** has no retry worth the name, and redelivering replays the same failure. Every M-PESA handler answers **200**, including on an internal error. Recovery is reconciliation, not the retry.
- **Stripe** redelivers with backoff for three days. A transient failure returns **500** so it *is* retried; only a bad signature is a permanent **400**.

### Verifying the caller

Stripe signs its webhooks. `verifyStripeSignature` checks the HMAC over the **raw** body — `request.text()`, never `request.json()`, since re-serialising parsed JSON changes key order and the check then fails for reasons that look like a bad secret. It also rejects replays outside a 300s tolerance and accepts any of several `v1` signatures, which is what makes endpoint-secret rotation survivable. Without this check, anyone who knows your URL can POST a completed session and pay for nothing.

Safaricom signs nothing. For C2B, `validateC2BReference` is the only gate before money moves: it declines an account number you do not recognise, and declines on an internal error too — an accepted payment you cannot attribute costs more to unwind than a declined one costs to retry. (`mpesa-stk`'s relay adds signatures to STK callbacks; see the parent repo.)

## Storage

The `BillingStore` port is six methods. Two implementations ship:

- **`PostgresStore`** — `pg`, two tables, `migrate()` is `IF NOT EXISTS` throughout. Table names take a prefix (default `billing_`) so it can sit beside an existing schema, including `mpesa-stk`'s own `mpesa_payments`.
- **`MemoryStore`** — tests and local development. Nothing survives a restart.

Using Drizzle, Prisma, or Mongo? Implement `BillingStore` against it. The only hard requirement is in the contract: `settlePayment` must be one atomic compare-and-swap and `createPayment` must rely on a real uniqueness constraint on `(rail, provider_ref)` — not on reading first.

## Relationship to `mpesa-stk`

Adjacent layers, in the same repo:

- **`mpesa-stk`** is the STK Push lifecycle done to the end — idempotent initiation, callback dedup, a poll fallback for the callback Daraja drops, reconciliation against the STK Query API, and a signing relay.
- **`mpesa-billing`** (this package) covers four rails including the two the library deliberately leaves out, and gives them one settlement contract — but has no poll fallback and no reconciliation.

If you only need STK Push, use the library. Best of both: the library for the STK lifecycle, `applyOnSettle` here for everything a settled payment should cause.

## Known gaps

In the order they will bite:

- **No reconciliation.** A dropped STK callback leaves a `PENDING` row until someone notices. `mpesa-stk`'s `reconcile()` is the fix, and it is not wired in here.
- **No STK idempotency key.** The record is keyed by the `CheckoutRequestID` Daraja returns, which does not exist until the push has already been sent, so a double-tapped "Pay" sends two prompts. The library owns that problem.
- **No B2C status query.** A payout that times out in Daraja's queue is marked `FAILED`; only a transaction-status query can tell you whether the money moved.
- **Amounts are decimal strings** end to end (`NUMERIC(14,2)` in Postgres). Never parse them into floats to do arithmetic.

## Environment variables

`darajaConfigFromEnv()` and `stripeConfigFromEnv()` read these, if you would rather not build the config objects yourself. See `env.example` in this directory.

MIT
