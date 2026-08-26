import { describe, it, expect } from 'vitest'
import { PostgresStore } from '../src/adapters/postgres.js'
import { fromMajor } from '../src/money.js'
import type { Pool, PoolClient } from 'pg'

// The adapter's own comment says the Postgres store is where the exactly-once
// guarantee has to be earned, so the SQL it builds is asserted directly: the
// CAS guard in the UPDATE, the ON CONFLICT on the insert, and the transaction
// bracketing. A fake pool records every query; no database is needed.

interface Recorded {
  text: string
  values: unknown[]
}

class FakePool {
  readonly queries: Recorded[] = []
  readonly clientQueries: Recorded[] = []
  /** Rows the next client query returns, in order. */
  responses: unknown[][] = []
  released = 0

  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, values })
    return { rows: this.responses.shift() ?? [] }
  }

  async connect(): Promise<PoolClient> {
    const pool = this
    return {
      async query(text: string, values: unknown[] = []) {
        pool.clientQueries.push({ text, values })
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] }
        return { rows: pool.responses.shift() ?? [] }
      },
      release() {
        pool.released += 1
      },
    } as unknown as PoolClient
  }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay-1',
    rail: 'stk',
    reference: 'ORDER-42',
    provider_ref: 'ws_CO_1',
    amount_minor: '50000',
    currency: 'KES',
    settled_amount_minor: null,
    settled_currency: null,
    status: 'PENDING',
    payer_ref: null,
    receipt: null,
    failure_code: null,
    failure_reason: null,
    raw: null,
    created_at: new Date('2026-08-26T12:00:00Z'),
    settled_at: null,
    ...overrides,
  }
}

function store(pool: FakePool, prefix?: string): PostgresStore {
  return new PostgresStore(pool as unknown as Pool, prefix ? { tablePrefix: prefix } : {})
}

describe('table prefix', () => {
  it('is validated rather than escaped, because it is interpolated into DDL', () => {
    expect(() => store(new FakePool(), 'evil"; DROP TABLE users; --')).toThrow(/Invalid tablePrefix/)
    expect(() => store(new FakePool(), 'Billing_')).toThrow(/Invalid tablePrefix/)
    expect(() => store(new FakePool(), 'tenant_a_')).not.toThrow()
  })

  it('lets two tenants share a database without sharing rows', async () => {
    const pool = new FakePool()
    await store(pool, 'tenant_a_').getPayment('stk', 'x')
    expect(pool.queries[0]?.text).toContain('FROM tenant_a_payments')
  })
})

describe('migrate', () => {
  it('creates the table with every rail, the dedup constraint, and minor-unit amounts', async () => {
    const pool = new FakePool()
    await store(pool).migrate()

    const ddl = pool.queries.map((q) => q.text).join('\n')
    expect(ddl).toContain("rail IN ('stk','c2b','b2c','b2b','stripe')")
    expect(ddl).toContain('UNIQUE (rail, provider_ref)')
    expect(ddl).toContain('amount_minor   BIGINT NOT NULL')
    expect(ddl).toContain('currency       CHAR(3) NOT NULL')
    // A settled amount without its currency would be the original bug again.
    expect(ddl).toContain('(settled_amount_minor IS NULL) = (settled_currency IS NULL)')
  })

  it('is safe to run on every boot', async () => {
    const pool = new FakePool()
    await store(pool).migrate()

    for (const { text } of pool.queries) {
      const statement = text.trim()
      if (statement.startsWith('CREATE TABLE')) expect(statement).toContain('IF NOT EXISTS')
      if (statement.startsWith('CREATE INDEX')) expect(statement).toContain('IF NOT EXISTS')
      if (statement.startsWith('ALTER TABLE')) expect(statement).toContain('IF NOT EXISTS')
    }
  })

  it('adds the settled-amount columns to a table an older version created', async () => {
    const pool = new FakePool()
    await store(pool).migrate()

    const alters = pool.queries.filter((q) => q.text.includes('ADD COLUMN'))
    expect(alters.map((q) => q.text).join('\n')).toContain('settled_amount_minor BIGINT')
    expect(alters.map((q) => q.text).join('\n')).toContain('settled_currency CHAR(3)')
  })
})

describe('createPayment', () => {
  it('relies on the unique constraint, never on reading first', async () => {
    const pool = new FakePool()
    pool.responses = [[row()]]

    await store(pool).createPayment({
      id: 'pay-1',
      rail: 'stk',
      reference: 'ORDER-42',
      providerRef: 'ws_CO_1',
      amount: fromMajor(500, 'KES'),
      status: 'PENDING',
      createdAt: new Date(),
    })

    const query = pool.queries[0]
    expect(query?.text).toContain('ON CONFLICT (rail, provider_ref) DO NOTHING')
    expect(query?.text).not.toMatch(/SELECT/i)
    // Minor units and the currency go in as separate columns.
    expect(query?.values).toContain(50000)
    expect(query?.values).toContain('KES')
  })

  it('returns null when the row already existed', async () => {
    const pool = new FakePool()
    pool.responses = [[]]

    const result = await store(pool).createPayment({
      id: 'pay-1',
      rail: 'stk',
      reference: 'ORDER-42',
      providerRef: 'ws_CO_1',
      amount: fromMajor(500, 'KES'),
      status: 'PENDING',
      createdAt: new Date(),
    })

    expect(result).toBeNull()
  })
})

describe('settlePayment', () => {
  it('is one compare-and-swap guarded on PENDING', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ status: 'SUCCESS', receipt: 'NLJ7RT61SV', settled_at: new Date() })]]

    await store(pool).settlePayment('stk', 'ws_CO_1', { status: 'SUCCESS', receipt: 'NLJ7RT61SV' })

    const update = pool.clientQueries.find((q) => q.text.includes('UPDATE'))
    expect(update?.text).toContain("status = 'PENDING'")
    expect(update?.text).toContain('RETURNING *')
    expect(pool.clientQueries.map((q) => q.text)).toEqual(['BEGIN', expect.stringContaining('UPDATE'), 'COMMIT'])
  })

  it('records the settled amount next to the requested one', async () => {
    const pool = new FakePool()
    pool.responses = [
      [row({ status: 'SUCCESS', settled_amount_minor: '49900', settled_currency: 'KES' })],
    ]

    const settled = await store(pool).settlePayment('stk', 'ws_CO_1', {
      status: 'SUCCESS',
      settledAmount: fromMajor(499, 'KES'),
    })

    expect(settled?.amount).toEqual({ currency: 'KES', minor: 50000 })
    expect(settled?.settledAmount).toEqual({ currency: 'KES', minor: 49900 })
    const update = pool.clientQueries.find((q) => q.text.includes('UPDATE'))
    expect(update?.values).toContain(49900)
  })

  it('returns null and commits when the CAS matched nothing', async () => {
    const pool = new FakePool()
    pool.responses = [[]]

    expect(await store(pool).settlePayment('stk', 'ws_CO_1', { status: 'SUCCESS' })).toBeNull()
    expect(pool.clientQueries.at(-1)?.text).toBe('COMMIT')
    expect(pool.released).toBe(1)
  })

  it('rolls back and releases the client when applyOnSettle throws', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ status: 'SUCCESS' })]]

    await expect(
      store(pool).settlePayment('stk', 'ws_CO_1', { status: 'SUCCESS' }, async () => {
        throw new Error('grant failed')
      }),
    ).rejects.toThrow('grant failed')

    expect(pool.clientQueries.map((q) => q.text)).toContain('ROLLBACK')
    expect(pool.clientQueries).not.toContainEqual(expect.objectContaining({ text: 'COMMIT' }))
    expect(pool.released).toBe(1)
  })

  it('hands applyOnSettle the same client, so its writes are in the transaction', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ status: 'SUCCESS' })]]
    let sawClient: unknown

    await store(pool).settlePayment('stk', 'ws_CO_1', { status: 'SUCCESS' }, async (_payment, tx) => {
      sawClient = tx
      await (tx as PoolClient).query('UPDATE orders SET paid = true', [])
    })

    expect(sawClient).toBeDefined()
    expect(pool.clientQueries.map((q) => q.text)).toContain('UPDATE orders SET paid = true')
    expect(pool.clientQueries.at(-1)?.text).toBe('COMMIT')
  })
})

describe('recordSettledPayment', () => {
  it('uses the insert itself as the dedup guard — C2B has no prior row', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ rail: 'c2b', status: 'SUCCESS', settled_amount_minor: '50000', settled_currency: 'KES' })]]

    await store(pool).recordSettledPayment({
      id: 'c2b-1',
      rail: 'c2b',
      reference: 'ORDER-42',
      providerRef: 'RKTQDM7W6S',
      amount: fromMajor(500, 'KES'),
      status: 'SUCCESS',
      createdAt: new Date(),
      settledAt: new Date(),
    })

    const insert = pool.clientQueries.find((q) => q.text.includes('INSERT'))
    expect(insert?.text).toContain('ON CONFLICT (rail, provider_ref) DO NOTHING')
  })

  it('defaults the settled amount to the requested one', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ rail: 'c2b', status: 'SUCCESS' })]]

    await store(pool).recordSettledPayment({
      id: 'c2b-1',
      rail: 'c2b',
      reference: 'ORDER-42',
      providerRef: 'RKTQDM7W6S',
      amount: fromMajor(500, 'KES'),
      status: 'SUCCESS',
      createdAt: new Date(),
    })

    // amount_minor and settled_amount_minor both present.
    expect(pool.clientQueries.find((q) => q.text.includes('INSERT'))?.values.filter((v) => v === 50000)).toHaveLength(2)
  })
})

describe('reading rows back', () => {
  it('rebuilds Money from the minor-unit column and its currency', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ rail: 'stripe', amount_minor: '500', currency: 'USD' })]]

    const payment = await store(pool).getPayment('stripe', 'cs_test_1')

    // 500 USD minor units is five dollars, not five hundred.
    expect(payment?.amount).toEqual({ currency: 'USD', minor: 500 })
  })

  it('refuses a row whose rail or status it does not recognise', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ rail: 'crypto' })]]

    await expect(store(pool).getPayment('stk', 'x')).rejects.toThrow(/unknown rail\/status/)
  })

  it('refuses a row whose amount is not a number', async () => {
    const pool = new FakePool()
    pool.responses = [[row({ amount_minor: 'lots' })]]

    await expect(store(pool).getPayment('stk', 'x')).rejects.toThrow(/non-numeric amount/)
  })
})

describe('token cache', () => {
  it('keeps one row per environment and overwrites it', async () => {
    const pool = new FakePool()
    await store(pool).putCachedToken('sandbox', { accessToken: 't', expiresAt: new Date() })

    expect(pool.queries[0]?.text).toContain('ON CONFLICT (environment)')
    expect(pool.queries[0]?.text).toContain('DO UPDATE SET')
  })

  it('only returns a token still valid at the given instant', async () => {
    const pool = new FakePool()
    pool.responses = [[]]

    expect(await store(pool).getCachedToken('live', new Date())).toBeNull()
    expect(pool.queries[0]?.text).toContain('expires_at > $2')
  })
})
