/**
 * SafariCharge's billing wiring — the whole application-specific half.
 *
 * The package knows nothing about organizations or plan tiers. It carries an
 * opaque `reference` and tells you, exactly once, when a payment settled;
 * everything below is this app deciding what that means.
 *
 * Import { billing } from '@/lib/billing' in route handlers. Do not construct
 * it inside a handler — you would get a new pool per request. Run
 * store.migrate() once from instrumentation.ts, not at module scope.
 */

import { Billing, darajaConfigFromEnv, stripeConfigFromEnv } from 'mpesa-billing'
import { PostgresStore } from 'mpesa-billing/adapters/postgres'
import { Pool, type PoolClient } from 'pg'

/** How long one payment buys. */
const PREMIUM_PERIOD_DAYS = 30

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })

export const store = new PostgresStore(pool)

export const billing = new Billing({
  store,
  mpesa: darajaConfigFromEnv(),
  stripe: stripeConfigFromEnv(),

  /**
   * The plan grant, inside the settlement transaction: a payment that is
   * recorded but not granted, or granted but not recorded, is the one outcome
   * worth going out of our way to prevent.
   *
   * The expiry is computed in SQL from the row's current value rather than
   * from a timestamp read earlier in the request, so paying twice in a month
   * adds two months instead of two writes both landing on `now + 30`.
   */
  applyOnSettle: async (payment, tx) => {
    if (payment.status !== 'SUCCESS') return
    // Payouts leave the business; they do not buy anything.
    if (payment.rail === 'b2c') return

    await (tx as PoolClient).query(
      `UPDATE organizations
          SET plan_tier = 'premium',
              plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), now())
                                  + make_interval(days => $2),
              updated_at = now()
        WHERE id = $1`,
      [payment.reference, PREMIUM_PERIOD_DAYS],
    )
  },

  /**
   * C2B customers type their organization id as the account number. Reject
   * anything that is not a live organization before Safaricom moves the money
   * — an unattributable payment has to be refunded by hand.
   */
  validateC2BReference: async (reference) => {
    if (!/^[0-9a-f-]{36}$/i.test(reference)) return false
    const { rows } = await pool.query(
      'SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL',
      [reference],
    )
    return rows.length > 0
  },
})

// Work that may lag. A throw here is logged and swallowed by the package —
// it must never become a non-200 that makes the provider redeliver.
billing.onPaymentSettled(async (payment) => {
  console.log('[billing] settled', payment.rail, payment.reference, payment.status, payment.receipt)
})
