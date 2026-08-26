# SafariCharge — multi-tenant billing on `mpesa-billing`

What a real application adds on top of the package: an organization id as the
payment `reference`, and a plan tier granted when a payment settles.

Everything project-specific is in **`lib/billing.ts`** — one `applyOnSettle`
that grants the plan inside the settlement transaction, and one
`validateC2BReference` that declines account numbers that are not live
organizations. The six webhook routes are three lines each, because the
dedup, the reply conventions, and the signature check are the package's job.

## Files

| Path | What it is |
|---|---|
| `lib/billing.ts` | The `Billing` singleton — plan grant, C2B validation, settled hook |
| `app/api/billing/mpesa/initiate/route.ts` | Initiation, where authorization lives |
| `app/api/webhooks/**` | The six webhook routes |
| `migrations/0001_plan_tier.sql` | `plan_tier` columns and the RLS read policy |

Imports here are relative so the example reads standalone; in the app they are
`@/lib/billing`.

## Wiring it up

```bash
npm install mpesa-billing pg
psql "$DATABASE_URL" -f examples/safaricharge/migrations/0001_plan_tier.sql
```

Run the package's own migration once at startup, not at module scope — Next.js
re-evaluates modules across serverless invocations:

```typescript
// instrumentation.ts   (Next.js 14.1+)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { store } = await import('./lib/billing')
    await store.migrate()
  }
}
```

Then register the C2B URLs once per shortcode, and again whenever the callback
domain changes:

```typescript
await billing.registerC2BUrls()   // defaults to ResponseType 'Cancelled'
```

## What settles what

| Rail | Grants premium | Notes |
|---|---|---|
| STK Push | yes | `reference` is the organization id |
| C2B | yes | Customer types the organization id as the account number |
| Stripe Checkout | yes | For organizations paying from outside Kenya |
| B2C | no | A payout leaves the business; `applyOnSettle` skips it |

## Migrating from the old hand-rolled tables

The previous implementation had one table per rail (`mpesa_transactions`,
`mpesa_c2b_transactions`, `mpesa_b2c_requests`, `stripe_transactions`), each
with an `organization_id uuid`. The package uses one `billing_payments` table
keyed by `(rail, provider_ref)`, with the organization id in `reference`. The
shape of a backfill:

```sql
INSERT INTO billing_payments (id, rail, reference, provider_ref, amount, currency, status,
                              payer_ref, receipt, created_at, settled_at)
SELECT id, 'stk', organization_id::text, checkout_request_id, amount::numeric, 'kes',
       CASE status WHEN 'completed' THEN 'SUCCESS'
                   WHEN 'failed'    THEN 'FAILED'
                   ELSE 'PENDING' END,
       phone_number, receipt_number, created_at,
       CASE WHEN status <> 'pending' THEN updated_at END
  FROM mpesa_transactions
ON CONFLICT (rail, provider_ref) DO NOTHING;
```

Repeat per rail, changing `rail` and the column mapping; `stripe_transactions`
maps `checkout_session_id` → `provider_ref` and `stripe_payment_intent_id` →
`receipt`. Backfill before cutting the routes over, so an in-flight callback
lands on a row that exists.
