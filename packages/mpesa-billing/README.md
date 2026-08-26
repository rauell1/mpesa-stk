# mpesa-billing

M-PESA and Stripe payment rails with one settlement contract, portable across projects.

Five rails — STK Push, C2B, B2C, B2B, Stripe Checkout — that all end the same way: exactly one delivery settles a payment, and exactly one gets to act on it. Every amount carries its currency in minor units, so KES 500 and USD 5.00 never collide. Zero runtime dependencies; `pg` is an optional peer for the Postgres store.

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
import { Billing, SAFARICOM_CALLBACK_CIDRS } from 'mpesa-billing'
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
  // Safaricom signs nothing; this stands in for a signature. See "Verifying the caller".
  trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS,
  // Runs inside the settlement transaction — see "Acting on a payment" below.
  applyOnSettle: async (payment, tx) => {
    if (payment.status !== 'SUCCESS') return
    const paid = payment.settledAmount ?? payment.amount
    await (tx as PoolClient).query(
      'UPDATE orders SET paid = true WHERE id = $1 AND price_minor <= $2 AND currency = $3',
      [payment.reference, paid.minor, paid.currency],
    )
  },
  // C2B: the only gate before Safaricom moves the customer's money.
  validateC2BReference: async (reference) => orderExists(reference),
})

const { payment, customerMessage } = await billing.initiateStkPush({
  reference:   'ORDER-42',                        // your id — this is what comes back on settlement
  phoneNumber: '0712345678',
  amount:      { amount: 500, currency: 'KES' },  // never a bare number
})
```

`reference` is the whole portability story: an order number, an organization id, a user id — whatever the payment is *for* in your system. This package never interprets it.

## Money

Every amount is `{ currency, minor }` — an ISO-4217 code and an integer count of the currency's minor unit. KES 500 is `{ currency: 'KES', minor: 50000 }`; USD 5.00 is `{ currency: 'USD', minor: 500 }`.

This is not ceremony. The rails disagree about what a number means: Daraja's `Amount: 500` is five hundred shillings, Stripe's `unit_amount: 500` is five dollars. A single `amount` column holding "500" cannot tell them apart, and the currency column only helps if every read remembers to consult it.

```typescript
import { fromMajor, fromMinor, toMajorString, formatMoney } from 'mpesa-billing'

fromMajor('19.99', 'USD')     // { currency: 'USD', minor: 1999 } — parsed as digits, not 19.99 * 100
fromMinor(50000, 'KES')       // { currency: 'KES', minor: 50000 }
toMajorString({ currency: 'KES', minor: 50000 })  // '500.00'
formatMoney({ currency: 'USD', minor: 500 })      // 'USD 5.00'
```

At an API boundary either shape is accepted: `{ amount: 500, currency: 'KES' }` (major units) or `{ minor: 50000, currency: 'KES' }`.

The details that matter:

- **No float arithmetic anywhere.** `19.99 * 100` is `1998.9999999999998`; decimal strings are parsed digit by digit instead.
- **Zero- and three-decimal currencies are handled.** JPY 1000 is 1000 minor units, KWD 1.234 is 1234. Passing `1000.5` for JPY throws rather than rounding.
- **Excess precision is refused, never truncated.** `fromMajor('5.005', 'USD')` throws — silently dropping a half-cent is how ledgers stop balancing.
- **Conversions are explicit.** `toDarajaAmount` returns whole shillings and rejects any non-KES amount or one carrying cents; `toStripeUnitAmount` returns minor units.
- **`amount` vs `settledAmount`.** `amount` is what you asked for; `settledAmount` is what the provider says actually moved. Both are stored. On C2B the customer types the amount, so they routinely differ — **check `settledAmount` before you fulfil anything**.

In Postgres these are `amount_minor BIGINT` and `currency CHAR(3)`, with a constraint that a settled amount can never exist without its currency.

## Rails

| Rail | Direction | Started by | Settled by |
|---|---|---|---|
| STK Push | in | `initiateStkPush` | STK callback |
| C2B | in | the customer, at the till | C2B confirmation |
| B2C | out | `initiateB2C` | B2C result / timeout |
| B2B | out | `initiateB2B` | B2B result / timeout |
| Stripe Checkout | in | `createStripeCheckout` | Stripe webhook |

### B2B

Paying another business — their paybill or till:

```typescript
const { payment } = await billing.initiateB2B({
  reference:        'INV-2026-001',                  // your invoice id
  receiverShortCode:'600000',                        // theirs
  accountReference: 'ACC-77',                        // the account number on *their* statement
  amount:           { amount: 1500, currency: 'KES' },
  remarks:          'Invoice 2026-001',
})
// payment.status === 'PENDING' — Daraja acknowledges, then reports on the result URL
```

`commandId` defaults to `BusinessPayBill`, which requires `accountReference`; use `BusinessBuyGoods` (with `receiverIdentifierType: '2'`) for a till, or `DisburseFundsToBusiness` / `BusinessToBusinessTransfer` between shortcodes you control.

Three details in the B2B wire format differ from B2C, and each fails as an unhelpful generic error. The package handles all three, but they are worth knowing: the operator field is `Initiator`, not `InitiatorName`; `PartyB` is a shortcode and must **not** go through phone normalisation; and Safaricom's own field is spelled `RecieverIdentifierType` — that typo is part of the wire format.

## Webhook routes (Next.js App Router)

```typescript
// app/api/webhooks/mpesa/route.ts
import { createWebhookRoutes } from 'mpesa-billing/next'
import { billing } from '@/lib/billing'

export const runtime = 'nodejs'
export const POST = createWebhookRoutes(billing).stkCallback
```

The eight handlers map to the eight default paths:

| Route | Handler | Called by |
|---|---|---|
| `/api/webhooks/mpesa` | `stkCallback` | Safaricom |
| `/api/webhooks/mpesa/c2b/validation` | `c2bValidation` | Safaricom |
| `/api/webhooks/mpesa/c2b/confirmation` | `c2bConfirmation` | Safaricom |
| `/api/webhooks/mpesa/b2c/result` | `b2cResult` | Safaricom |
| `/api/webhooks/mpesa/b2c/timeout` | `b2cTimeout` | Safaricom |
| `/api/webhooks/mpesa/b2b/result` | `b2bResult` | Safaricom |
| `/api/webhooks/mpesa/b2b/timeout` | `b2bTimeout` | Safaricom |
| `/api/webhooks/stripe` | `stripeWebhook` | Stripe |

Different paths? Set `callbackPaths` on the Daraja config — the URLs sent to Safaricom are built from it, so the two cannot drift.

Not on Next? The handlers are plain `(Request) => Response`, so they work in Hono, Bun, or any Web-standard runtime. On Express, or anywhere else, call the framework-agnostic methods directly — each takes the raw body string and returns `{ reply: { status, body }, settled, duplicate }`:

```typescript
app.post('/api/webhooks/mpesa', express.text({ type: '*/*' }), async (req, res) => {
  const { reply } = await billing.handleStkCallback(req.body, { sourceIp: req.ip })
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

The same guard is what makes a payout's result and its queue timeout safe to race: whichever arrives first settles it, and the loser is a no-op.

### Acting on a payment

Two hooks, and the difference matters:

- **`applyOnSettle(payment, tx)`** runs *inside* the settlement transaction, on the winning delivery only. Throwing rolls the settlement back with it. Use it for anything that must be atomic with recording the payment: granting a plan, marking an order paid, releasing stock.
- **`onPaymentSettled(payment)`** runs after the commit. A throwing listener is logged and swallowed — it must not turn into a non-200 that makes the provider redeliver a payment you have already committed. Use it for work that may lag: receipts, notifications, analytics.

### Replying to the provider

The two providers want opposite things, and following the wrong convention is itself a bug:

- **Safaricom** has no retry worth the name, and redelivering replays the same failure. Every M-PESA handler answers **200**, including on an internal error. Recovery is reconciliation, not the retry.
- **Stripe** redelivers with backoff for three days. A transient failure returns **500** so it *is* retried; only a bad signature is a permanent **400**.

### Verifying the caller

**Stripe signs its webhooks.** `verifyStripeSignature` checks the HMAC over the **raw** body — `request.text()`, never `request.json()`, since re-serialising parsed JSON changes key order and the check then fails for reasons that look like a bad secret. It also rejects replays outside a 300s tolerance and accepts any of several `v1` signatures, which is what makes endpoint-secret rotation survivable.

**Safaricom signs nothing.** Two things stand in for a signature:

`trustedMpesaIps` checks the delivery against Safaricom's published callback ranges, exported as `SAFARICOM_CALLBACK_CIDRS`. This matters most on the C2B confirmation, which is the one handler that creates a settled payment from scratch — without it, anyone who knows that URL can POST a payment that never happened. Enforce the list at your WAF, or set the option and give the handlers a `sourceIp`:

```typescript
const billing = new Billing({ store, trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })
// and, in the binding:
createWebhookRoutes(billing, { sourceIpHeader: 'x-vercel-forwarded-for' })
```

Only trust a header a proxy *you control* writes. Everywhere else a header is client input, and an attacker who can set it can claim to be Safaricom.

Left unset, no check is made: the handlers cannot tell a missing `sourceIp` from a spoofed one, and silently rejecting every delivery behind a proxy that does not forward the IP would be worse than the gap it closes.

`validateC2BReference` is the second: it declines an account number you do not recognise before the money moves, and declines on an internal error too — an accepted payment you cannot attribute costs more to unwind than a declined one costs to retry.

## Storage

The `BillingStore` port is six methods. Two implementations ship:

- **`PostgresStore`** — `pg`, two tables, `migrate()` is `IF NOT EXISTS` throughout and brings an older table up to the current shape. Table names take a prefix (default `billing_`) so it can sit beside an existing schema, including `mpesa-stk`'s own `mpesa_payments`.
- **`MemoryStore`** — tests and local development. Nothing survives a restart.

Using Drizzle, Prisma, or Mongo? Implement `BillingStore` against it. The only hard requirement is in the contract: `settlePayment` must be one atomic compare-and-swap and `createPayment` must rely on a real uniqueness constraint on `(rail, provider_ref)` — not on reading first.

## Relationship to `mpesa-stk`

Adjacent layers, in the same repo:

- **`mpesa-stk`** is the STK Push lifecycle done to the end — idempotent initiation, callback dedup, a poll fallback for the callback Daraja drops, reconciliation against the STK Query API, and a signing relay.
- **`mpesa-billing`** (this package) covers five rails including the three the library leaves out, and gives them one settlement contract — but has no poll fallback and no reconciliation.

If you only need STK Push, use the library. Best of both: the library for the STK lifecycle, `applyOnSettle` here for everything a settled payment should cause.

## Known gaps

In the order they will bite:

- **No reconciliation.** A dropped STK callback leaves a `PENDING` row until someone notices. `mpesa-stk`'s `reconcile()` is the fix, and it is not wired in here.
- **No STK idempotency key.** The record is keyed by the `CheckoutRequestID` Daraja returns, which does not exist until the push has already been sent, so a double-tapped "Pay" sends two prompts. The library owns that problem.
- **No payout status query.** A B2C or B2B payout that times out in Daraja's queue is marked `FAILED`; only a transaction-status query can tell you whether the money moved. The CAS at least means a result that arrives later cannot be overwritten by the timeout, and vice versa.
- **Outbound calls are tested against a mocked Daraja**, not the live sandbox. The request shapes are asserted field by field; the sandbox's own behaviour is not.

## Environment variables

`darajaConfigFromEnv()` and `stripeConfigFromEnv()` read these, if you would rather not build the config objects yourself. See `env.example` in this directory. A `MPESA_SECURITY_CERTIFICATE` carrying literal `\n` escapes — which is how Docker, Kubernetes, Vercel, and GitHub Actions hand over a multi-line secret — is repaired automatically.

MIT
