import type { Money } from '../money.js'
import type { BillingPayment, MpesaEnvironment, PaymentStatus, Rail } from '../types.js'

/**
 * Fields a settlement may write. Status is required — a settlement that does
 * not change the status is an update, not a settlement.
 */
export interface SettleUpdates {
  status: Exclude<PaymentStatus, 'PENDING'>
  receipt?: string
  payerRef?: string
  /**
   * What the provider says actually moved. Recorded alongside the requested
   * amount rather than overwriting it: the two differing is a real event worth
   * being able to see, not a correction to apply silently.
   */
  settledAmount?: Money
  failureCode?: string
  failureReason?: string
  raw?: unknown
}

/**
 * Work to run inside the same transaction as the settlement it accompanies.
 *
 * `tx` is adapter-specific — a `pg` PoolClient for PostgresStore, undefined for
 * MemoryStore. Use it when the consequence of a payment must be atomic with
 * recording that payment (granting a plan, marking an order paid); use the
 * `onPaymentSettled` hook instead when it may lag (sending a receipt email).
 */
export type ApplyInTransaction = (payment: BillingPayment, tx: unknown) => Promise<void>

export interface CachedToken {
  accessToken: string
  expiresAt: Date
}

export interface BillingStore {
  /**
   * Insert a PENDING payment.
   *
   * Returns the stored record, or null if a payment with the same
   * (rail, providerRef) already exists — a retried initiation, not a second
   * payment. Implementations MUST enforce that uniqueness in the database, not
   * by reading first.
   */
  createPayment(payment: BillingPayment): Promise<BillingPayment | null>

  getPayment(rail: Rail, providerRef: string): Promise<BillingPayment | null>

  getPaymentByReference(rail: Rail, reference: string): Promise<BillingPayment | null>

  /**
   * Atomically move a PENDING payment to a terminal status.
   *
   * Returns the settled record, or null when there was nothing to settle:
   * either the payment is already terminal (a redelivered webhook) or the
   * providerRef is unknown (a delivery for a payment we never issued).
   *
   * Implementations MUST do this as one compare-and-swap
   * (`UPDATE … WHERE status = 'PENDING' … RETURNING`). A read-then-write leaves
   * a window where two concurrent deliveries both believe they won, which is
   * how a customer gets charged once and credited twice.
   */
  settlePayment(
    rail: Rail,
    providerRef: string,
    updates: SettleUpdates,
    apply?: ApplyInTransaction,
  ): Promise<BillingPayment | null>

  /**
   * Insert an already-terminal payment — the C2B case, where the money moved
   * before we had any record of it.
   *
   * Returns the stored record, or null if (rail, providerRef) already exists.
   * The uniqueness constraint is the deduplication guard, exactly as with
   * `settlePayment`'s CAS.
   */
  recordSettledPayment(
    payment: BillingPayment,
    apply?: ApplyInTransaction,
  ): Promise<BillingPayment | null>

  /** Newest cached Daraja token for the environment that is still valid at `validAt`. */
  getCachedToken(environment: MpesaEnvironment, validAt: Date): Promise<CachedToken | null>

  putCachedToken(environment: MpesaEnvironment, token: CachedToken): Promise<void>
}
