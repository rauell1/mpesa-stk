/**
 * PostgreSQL store using the `pg` package.
 *
 * `pg` is a peer dependency — the host app owns the pool. Call `migrate()`
 * once on startup; it is `IF NOT EXISTS` throughout and safe on every boot.
 *
 * Table names take a prefix (default `billing_`) so this can live beside an
 * existing schema — including the `mpesa_payments` table the `mpesa-stk`
 * library creates — without either owning the other's rows.
 */

import type { Pool, PoolClient } from 'pg'
import type { BillingPayment, MpesaEnvironment, PaymentStatus, Rail } from '../types.js'
import type { ApplyInTransaction, BillingStore, CachedToken, SettleUpdates } from './types.js'

interface PaymentRow {
  id: string
  rail: string
  reference: string
  provider_ref: string
  amount: string
  currency: string
  status: string
  payer_ref: string | null
  receipt: string | null
  failure_code: string | null
  failure_reason: string | null
  raw: unknown | null
  created_at: Date
  settled_at: Date | null
}

const RAILS = new Set<string>(['stk', 'c2b', 'b2c', 'stripe'])
const STATUSES = new Set<string>(['PENDING', 'SUCCESS', 'FAILED'])

function rowToPayment(row: PaymentRow): BillingPayment {
  if (!RAILS.has(row.rail) || !STATUSES.has(row.status)) {
    throw new Error(
      `Payment ${row.id} has an unknown rail/status ("${row.rail}"/"${row.status}") — ` +
        'check for manual edits or a partially applied migration.',
    )
  }

  const payment: BillingPayment = {
    id: row.id,
    rail: row.rail as Rail,
    reference: row.reference,
    providerRef: row.provider_ref,
    amount: row.amount,
    currency: row.currency,
    status: row.status as PaymentStatus,
    createdAt: row.created_at,
  }

  if (row.payer_ref !== null) payment.payerRef = row.payer_ref
  if (row.receipt !== null) payment.receipt = row.receipt
  if (row.failure_code !== null) payment.failureCode = row.failure_code
  if (row.failure_reason !== null) payment.failureReason = row.failure_reason
  if (row.raw !== null) payment.raw = row.raw
  if (row.settled_at !== null) payment.settledAt = row.settled_at

  return payment
}

export interface PostgresStoreOptions {
  /** Prefix for the two table names. Default 'billing_'. */
  tablePrefix?: string
}

export class PostgresStore implements BillingStore {
  private readonly payments: string
  private readonly tokens: string

  constructor(
    private readonly pool: Pool,
    options: PostgresStoreOptions = {},
  ) {
    const prefix = options.tablePrefix ?? 'billing_'
    if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) {
      // Interpolated into DDL and every query, so it is validated rather than escaped.
      throw new Error(`Invalid tablePrefix '${prefix}' — use lowercase letters, digits and underscores`)
    }
    this.payments = `${prefix}payments`
    this.tokens = `${prefix}mpesa_tokens`
  }

  /** Idempotent DDL. Run once at startup, before serving any webhook. */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.payments} (
        id             TEXT PRIMARY KEY,
        rail           TEXT NOT NULL CHECK (rail IN ('stk','c2b','b2c','stripe')),
        reference      TEXT NOT NULL,
        provider_ref   TEXT NOT NULL,
        amount         NUMERIC(14,2) NOT NULL,
        currency       TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING','SUCCESS','FAILED')),
        payer_ref      TEXT,
        receipt        TEXT,
        failure_code   TEXT,
        failure_reason TEXT,
        raw            JSONB,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        settled_at     TIMESTAMPTZ,
        -- The deduplication guard for every rail: one row per provider handle.
        CONSTRAINT ${this.payments}_provider_unique UNIQUE (rail, provider_ref)
      )
    `)

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.payments}_reference_idx ON ${this.payments} (reference)`,
    )
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.payments}_status_created_idx ON ${this.payments} (status, created_at)`,
    )

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tokens} (
        environment TEXT PRIMARY KEY CHECK (environment IN ('sandbox','live')),
        access_token TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
  }

  async createPayment(payment: BillingPayment): Promise<BillingPayment | null> {
    // ON CONFLICT DO NOTHING rather than a pre-flight SELECT: the unique
    // constraint is the only thing two concurrent inserts both respect.
    const { rows } = await this.pool.query<PaymentRow>(
      `INSERT INTO ${this.payments}
         (id, rail, reference, provider_ref, amount, currency, status, payer_ref, receipt, raw, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (rail, provider_ref) DO NOTHING
       RETURNING *`,
      [
        payment.id,
        payment.rail,
        payment.reference,
        payment.providerRef,
        payment.amount,
        payment.currency,
        payment.status,
        payment.payerRef ?? null,
        payment.receipt ?? null,
        payment.raw === undefined ? null : JSON.stringify(payment.raw),
        payment.createdAt,
      ],
    )

    return rows[0] ? rowToPayment(rows[0]) : null
  }

  async getPayment(rail: Rail, providerRef: string): Promise<BillingPayment | null> {
    const { rows } = await this.pool.query<PaymentRow>(
      `SELECT * FROM ${this.payments} WHERE rail = $1 AND provider_ref = $2`,
      [rail, providerRef],
    )
    return rows[0] ? rowToPayment(rows[0]) : null
  }

  async getPaymentByReference(rail: Rail, reference: string): Promise<BillingPayment | null> {
    const { rows } = await this.pool.query<PaymentRow>(
      `SELECT * FROM ${this.payments}
        WHERE rail = $1 AND reference = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [rail, reference],
    )
    return rows[0] ? rowToPayment(rows[0]) : null
  }

  async settlePayment(
    rail: Rail,
    providerRef: string,
    updates: SettleUpdates,
    apply?: ApplyInTransaction,
  ): Promise<BillingPayment | null> {
    return this.inTransaction(async (client) => {
      // One compare-and-swap. `status = 'PENDING'` in the WHERE clause is what
      // makes exactly one of N racing deliveries get a row back.
      const { rows } = await client.query<PaymentRow>(
        `UPDATE ${this.payments}
            SET status = $3,
                receipt = COALESCE($4, receipt),
                payer_ref = COALESCE($5, payer_ref),
                failure_code = $6,
                failure_reason = $7,
                raw = COALESCE($8::jsonb, raw),
                settled_at = now()
          WHERE rail = $1 AND provider_ref = $2 AND status = 'PENDING'
          RETURNING *`,
        [
          rail,
          providerRef,
          updates.status,
          updates.receipt ?? null,
          updates.payerRef ?? null,
          updates.failureCode ?? null,
          updates.failureReason ?? null,
          updates.raw === undefined ? null : JSON.stringify(updates.raw),
        ],
      )

      const row = rows[0]
      if (!row) return null

      const payment = rowToPayment(row)
      // Throwing here rolls the settlement back with it — that is the point.
      if (apply) await apply(payment, client)
      return payment
    })
  }

  async recordSettledPayment(
    payment: BillingPayment,
    apply?: ApplyInTransaction,
  ): Promise<BillingPayment | null> {
    return this.inTransaction(async (client) => {
      const { rows } = await client.query<PaymentRow>(
        `INSERT INTO ${this.payments}
           (id, rail, reference, provider_ref, amount, currency, status,
            payer_ref, receipt, raw, created_at, settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (rail, provider_ref) DO NOTHING
         RETURNING *`,
        [
          payment.id,
          payment.rail,
          payment.reference,
          payment.providerRef,
          payment.amount,
          payment.currency,
          payment.status,
          payment.payerRef ?? null,
          payment.receipt ?? null,
          payment.raw === undefined ? null : JSON.stringify(payment.raw),
          payment.createdAt,
          payment.settledAt ?? new Date(),
        ],
      )

      const row = rows[0]
      if (!row) return null

      const stored = rowToPayment(row)
      if (apply) await apply(stored, client)
      return stored
    })
  }

  async getCachedToken(environment: MpesaEnvironment, validAt: Date): Promise<CachedToken | null> {
    const { rows } = await this.pool.query<{ access_token: string; expires_at: Date }>(
      `SELECT access_token, expires_at FROM ${this.tokens}
        WHERE environment = $1 AND expires_at > $2`,
      [environment, validAt],
    )
    const row = rows[0]
    return row ? { accessToken: row.access_token, expiresAt: row.expires_at } : null
  }

  async putCachedToken(environment: MpesaEnvironment, token: CachedToken): Promise<void> {
    // One row per environment, overwritten — the old token is worthless the
    // moment a newer one exists, so there is nothing to prune.
    await this.pool.query(
      `INSERT INTO ${this.tokens} (environment, access_token, expires_at, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (environment)
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     expires_at = EXCLUDED.expires_at,
                     updated_at = now()`,
      [environment, token.accessToken, token.expiresAt],
    )
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
