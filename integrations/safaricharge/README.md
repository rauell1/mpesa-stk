# SafariCharge billing integration — M-PESA + Stripe

The multi-tenant billing rails from [SafariCharge](https://github.com/rauell1/safaricharge-v2), extracted so they can be read, reviewed, and reused on their own. Two payment providers, one outcome: an organization's `plan_tier` moves to `premium` until `plan_expires_at`.

TypeScript · Next.js App Router · Drizzle · Postgres.

| Rail | Direction | What it is here |
|---|---|---|
| **M-PESA STK Push** | customer → us | The prompt on the customer's phone. One row per push, settled by callback. |
| **M-PESA C2B** | customer → us | Paybill payments the customer starts themselves, with the organization id as the account number. Validated before the money moves. |
| **M-PESA B2C** | us → customer | Payouts and refunds. Acknowledged on request, settled on the result or timeout callback. |
| **Stripe Checkout** | customer → us | The card rail for organizations paying outside Kenya. Same table shape, same settlement contract. |

Everything is org-scoped: every payment row carries `organization_id`, RLS restricts reads to members of that organization, and the webhook handlers write over a service role that bypasses those policies.

## Layout

```
db/
  schema.ts         Drizzle tables (organizations, mpesa_*, stripe_transactions) + RLS policies
  client.ts         Thin db() handle — swap for your app's own
  migrations/       Standalone SQL, idempotent
src/
  mpesa/config.ts   Daraja primitives: EAT timestamps, STK password, B2C security credential, phone normalisation
  mpesa/token.ts    OAuth token, cached in Postgres
  mpesa/stk.ts      STK Push
  mpesa/c2b.ts      C2B URL registration + callback types
  mpesa/b2c.ts      B2C payment request
  stripe/           Checkout session creation, SDK handle
  billing/tiers.ts  The single tier-grant both rails settle into
routes/nextjs/      Drop-in App Router handlers (see the endpoint table below)
scripts/            One-off C2B URL registration
```

## Endpoints

| Route | Called by | Notes |
|---|---|---|
| `POST /api/billing/mpesa/initiate` | your client | Sends the STK prompt, writes a `pending` row |
| `POST /api/billing/stripe/checkout` | your client | Creates a Checkout session, writes a `pending` row |
| `POST /api/webhooks/mpesa` | Safaricom | STK callback — settles and grants |
| `POST /api/webhooks/mpesa/c2b/validation` | Safaricom | Accept/reject before the money moves |
| `POST /api/webhooks/mpesa/c2b/confirmation` | Safaricom | Records the payment, grants |
| `POST /api/webhooks/mpesa/b2c/result` | Safaricom | Payout outcome |
| `POST /api/webhooks/mpesa/b2c/timeout` | Safaricom | Payout expired in Daraja's queue |
| `POST /api/webhooks/stripe` | Stripe | Signature-verified; settles and grants |

Copy `routes/nextjs/**` into your `src/app/api/`, keeping the paths — the callback URLs the Daraja calls are built with (`src/mpesa/stk.ts`, `c2b.ts`, `b2c.ts`) assume exactly these.

## Install

```bash
npm install drizzle-orm pg zod stripe        # stripe only if you use the card rail
psql "$BILLING_DATABASE_URL" -f integrations/safaricharge/db/migrations/0001_billing_mpesa_stripe.sql
cp integrations/safaricharge/env.example .env   # then fill it in
```

The migration assumes `organizations` and `organization_members` already exist, plus an `authenticated` role and an `auth.user_id()` function from your auth layer (Neon Auth or Supabase). If your app already owns those tables, delete them from `db/schema.ts` and import your own.

## How settlement works

Both rails redeliver. Daraja re-fires the STK callback under load and gives you no idempotency key; Stripe retries any non-2xx for three days. A handler that reads a row, checks its status, and then writes will hand out two plan grants for one payment the first time two deliveries land together.

So settlement is a **compare-and-swap**, never a read-then-check:

```ts
const [settled] = await tx.update(mpesaTransactions)
  .set({ status: "completed", receiptNumber })
  .where(and(
    eq(mpesaTransactions.checkoutRequestId, checkoutRequestId),
    eq(mpesaTransactions.status, "pending"),      // ← the guard
  ))
  .returning({ organizationId: mpesaTransactions.organizationId })

if (!settled) return          // duplicate delivery, or an id we never issued
await grantPlanTier(tx, settled.organizationId)
```

Exactly one of N racing deliveries gets a row back, and only that one grants. C2B has no id of ours to update, so it uses the same guard in `INSERT … ON CONFLICT (trans_id) DO NOTHING … RETURNING` — the UNIQUE constraint on Safaricom's receipt is what makes the replay a no-op.

The grant itself extends from the row's current expiry in SQL (`GREATEST(COALESCE(plan_expires_at, now()), now()) + interval`), not from a timestamp read earlier in the request: paying twice in a month adds two months, and two writes cannot both compute `now + 30` off the same stale read.

### Responding to the provider

The two providers want opposite things on failure, and following the wrong convention is a bug in itself:

- **Safaricom** has no retry worth the name and re-delivering replays the same failure, so the handlers **always answer 200** — including on an internal error. Recovery is reconciliation, not the retry.
- **Stripe** redelivers with backoff, so a transient database error **returns 500** and is retried. Only a bad signature is a permanent `400`.

### Verifying the caller

Stripe signs its webhooks; the handler verifies over the **raw** body (`req.text()`, never `req.json()` — re-serialising changes key order and the signature fails). Without that check, anyone who knows the URL can POST a `checkout.session.completed` and grant themselves premium.

Safaricom signs nothing. The C2B validation handler is the only gate before money moves, so it rejects any account number that is not a live organization id, and rejects on internal error too: an accepted payment we cannot attribute has to be unwound by hand.

## Relationship to `mpesa-stk`

This directory and the library at the repository root solve adjacent problems and are not the same layer:

- **`mpesa-stk` (the library)** is STK Push done to the end — idempotent initiation, callback dedup, a poll fallback for the callback Daraja drops, reconciliation against the STK Query API, and an optional signing relay. Provider-agnostic about what you do with a settled payment.
- **This integration** is the tenant side — four rails including the two the library deliberately does not cover (C2B, B2C), a Stripe equivalent, and the org/plan-tier model all four settle into.

If you only need STK Push, use the library: the poll fallback and reconciliation here are missing, and a dropped callback stays `pending` until someone notices. The best of both is the library for the STK lifecycle plus `src/billing/tiers.ts` from here in its `onPaymentSettled` handler.

## Known gaps

Honest list, in the order they will bite:

- **No reconciliation.** A dropped STK callback leaves a `pending` row forever. The library's `reconcile()` is the fix; it is not wired up here.
- **Amounts are `text`.** Inherited from the app's schema so the two stay in sync. `numeric(12,2)` is the right type; changing it needs a coordinated migration on both sides.
- **B2C is not org-scoped.** `mpesa_b2c_requests` has no `organization_id`, so payouts are attributable only by phone number.
- **No initiation authorization.** Both initiate routes take `organizationId` from the request body; wire your own membership check at the marked spot before deploying.
- **`plan_tier` is a bare string.** `'free' | 'premium'` with no product catalogue behind it.

## A note on style

The code here uses semicolons and double quotes — the SafariCharge house style, not this repository's. That is deliberate: this directory is a mirror kept diffable against the app it came from, and it is excluded from the root `tsconfig.json` and `tsup` build for the same reason. The pure Daraja helpers are covered by `tests/integrations/safaricharge-mpesa-config.test.ts`, which does follow repository style and runs in CI.
