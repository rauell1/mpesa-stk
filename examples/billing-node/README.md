# Integrating `mpesa-billing` into a project

Two files, no application domain in either:

| File | What it shows |
|---|---|
| `billing.ts` | The one `Billing` instance — the store, the settlement hook, C2B validation, caller verification |
| `routes.ts` | The webhook routes on Next.js and on Express, and how to start a payment on each rail |

## Setup

```bash
npm install mpesa-billing pg
cp node_modules/mpesa-billing/env.example .env
```

Run the migration once at startup — not at module scope, since serverless
runtimes re-evaluate modules per invocation:

```typescript
await store.migrate()   // billing_payments + billing_mpesa_tokens, IF NOT EXISTS throughout
```

Then register the C2B URLs once per shortcode, and again whenever the callback
domain changes:

```typescript
await billing.registerC2BUrls()   // ResponseType 'Cancelled' by default
```

## The two things worth copying

**Amounts always carry their currency.** `{ amount: 500, currency: 'KES' }` and
`{ amount: '5.00', currency: 'USD' }` are 50000 and 500 minor units — different
quantities that stay different in the database and in `applyOnSettle`. There is
no API that takes a bare number.

**Check what was actually paid, not just that something was.** `settledAmount`
is what the provider says moved; `amount` is what you asked for. On C2B the
customer types the amount, so acting on `status === 'SUCCESS'` alone will
fulfil an order for whatever they felt like paying. `billing.ts` shows the
comparison.

## What this deliberately does not ship

**An initiation route.** Starting a payment is where authorization lives, and
it cannot be written generically — whatever identifies the payer in your system
has to be checked against your session before anything is spent against your
shortcode. `routes.ts` marks the spot.

**Reconciliation.** A dropped STK callback leaves a `PENDING` row until someone
notices. `mpesa-stk`'s `reconcile()` in the parent repo is the fix; the two
packages are designed to be used together.
