/**
 * Wiring `mpesa-billing` into any project.
 *
 * Nothing here knows what your application is. A payment carries a `reference`
 * — an order number, an invoice id, a user id, whatever the payment is *for* —
 * and this package hands it back to you, exactly once, when the payment
 * settles. What that means is `applyOnSettle`'s business, and yours.
 *
 * Construct this once per process and import it. Do not build it inside a
 * request handler: you would get a new connection pool per request.
 */

import { Billing, SAFARICOM_CALLBACK_CIDRS, darajaConfigFromEnv, stripeConfigFromEnv } from 'mpesa-billing'
import { PostgresStore } from 'mpesa-billing/adapters/postgres'
import { Pool, type PoolClient } from 'pg'

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })

export const store = new PostgresStore(pool)

export const billing = new Billing({
  store,
  mpesa: darajaConfigFromEnv(),
  stripe: stripeConfigFromEnv(),

  /**
   * Safaricom signs nothing, so this is what stands in for a signature. Drop
   * it only if a WAF or CDN in front of you already enforces the same list —
   * and see the note in the route file about trusting the header it comes
   * from.
   */
  trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS,

  /**
   * The consequence of a payment, inside the settlement transaction. It runs
   * only for the delivery that wins the compare-and-swap, so it is
   * exactly-once with the settlement itself; throwing rolls both back.
   *
   * Two things worth copying:
   *
   *  - Check what was actually paid. `settledAmount` is what the provider says
   *    moved; `amount` is what you asked for. On C2B the customer types the
   *    amount themselves, so they are routinely different — and fulfilling an
   *    order for KES 1 because you only looked at `status` is the classic way
   *    to lose money here.
   *  - Compare in minor units, with the currency. `payment.amount.minor` is
   *    50000 for KES 500 and 500 for USD 5.00; the bare number means nothing
   *    without `payment.amount.currency` next to it.
   */
  applyOnSettle: async (payment, tx) => {
    if (payment.status !== 'SUCCESS') return

    // A payout leaves the business; it does not buy anything.
    if (payment.rail === 'b2c' || payment.rail === 'b2b') return

    const paid = payment.settledAmount ?? payment.amount
    const client = tx as PoolClient

    const { rows } = await client.query<{ price_minor: string; currency: string }>(
      'SELECT price_minor, currency FROM orders WHERE id = $1 FOR UPDATE',
      [payment.reference],
    )
    const order = rows[0]
    if (!order) return // Not ours; the row is still recorded for reconciliation.

    const enough = paid.currency === order.currency && paid.minor >= Number(order.price_minor)
    if (!enough) {
      // Underpaid or paid in the wrong currency. Record it and let a human
      // decide — do not fulfil, and do not throw: throwing would roll back the
      // payment record too, and the money has already moved.
      await client.query('UPDATE orders SET payment_state = $2 WHERE id = $1', [
        payment.reference,
        'underpaid',
      ])
      return
    }

    await client.query('UPDATE orders SET payment_state = $2, paid_at = now() WHERE id = $1', [
      payment.reference,
      'paid',
    ])
  },

  /**
   * C2B only: the gate before Safaricom moves the customer's money. The
   * default accepts any non-empty account number, which means recording
   * payments you cannot attribute — so override it.
   */
  validateC2BReference: async (reference) => {
    const { rows } = await pool.query('SELECT 1 FROM orders WHERE id = $1', [reference])
    return rows.length > 0
  },
})

// Work that may lag — receipts, notifications, analytics. A throw here is
// logged and swallowed, so it can never become a non-200 that makes the
// provider redeliver a payment already committed.
billing.onPaymentSettled(async (payment) => {
  console.log('[billing] settled', payment.rail, payment.reference, payment.status, payment.receipt)
})
