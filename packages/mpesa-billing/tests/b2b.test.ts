import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { Billing } from '../src/billing.js'
import { MemoryStore } from '../src/adapters/memory.js'
import { fromMajor } from '../src/money.js'
import type { BillingPayment, DarajaConfig } from '../src/types.js'

// B2B settles through the same contract as every other rail: one delivery
// wins, one consequence fires.

const MPESA: DarajaConfig = {
  consumerKey: 'ck',
  consumerSecret: 'cs',
  shortCode: '174379',
  passKey: 'pk',
  environment: 'sandbox',
  callbackBaseUrl: 'https://app.example.com',
  initiatorName: 'testapi',
  initiatorPassword: 'pw',
  securityCertificate: '',
}

// A throwaway RSA public key: enough for publicEncrypt to accept.
const PUBLIC_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString()

afterEach(() => {
  vi.unstubAllGlobals()
})

async function seedPendingB2b(store: MemoryStore, conversationId = 'AG_B2B_1'): Promise<void> {
  await store.createPayment({
    id: 'b2b-1',
    rail: 'b2b',
    reference: 'INV-2026-001',
    providerRef: conversationId,
    amount: fromMajor(1500, 'KES'),
    status: 'PENDING',
    payerRef: '600000',
    createdAt: new Date(),
  })
}

/** A real B2B result: the receipt and amount live in ResultParameters. */
function b2bResult(conversationId: string, resultCode = 0): string {
  return JSON.stringify({
    Result: {
      ResultType: 0,
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Failed',
      OriginatorConversationID: 'O_1',
      ConversationID: conversationId,
      TransactionID: 'QKA81LK5CY',
      ResultParameters: {
        ResultParameter: [
          { Key: 'DebitAccountBalance', Value: 'Working Account|KES|46713.00' },
          { Key: 'Amount', Value: 1500 },
          { Key: 'TransCompletedTime', Value: 20260826180800 },
          { Key: 'ReceiverPartyPublicName', Value: '600000 - Supplier Ltd' },
          { Key: 'Currency', Value: 'KES' },
        ],
      },
    },
  })
}

describe('B2B settlement', () => {
  it('settles once, however many times Safaricom redelivers the result', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    const settled: BillingPayment[] = []
    billing.onPaymentSettled((p) => void settled.push(p))
    await seedPendingB2b(store)

    const results = await Promise.all([
      billing.handleB2BResult(b2bResult('AG_B2B_1')),
      billing.handleB2BResult(b2bResult('AG_B2B_1')),
      billing.handleB2BResult(b2bResult('AG_B2B_1')),
    ])

    expect(results.filter((r) => r.settled !== null)).toHaveLength(1)
    expect(results.filter((r) => r.duplicate)).toHaveLength(2)
    expect(settled).toHaveLength(1)
    // Every delivery is still acknowledged — Safaricom must not retry.
    expect(results.every((r) => r.reply.status === 200)).toBe(true)
  })

  it('records the receipt and the amount that actually moved, from ResultParameters', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store)

    const { settled } = await billing.handleB2BResult(b2bResult('AG_B2B_1'))

    expect(settled).toMatchObject({
      status: 'SUCCESS',
      receipt: 'QKA81LK5CY',
      settledAmount: { currency: 'KES', minor: 150000 },
    })
  })

  it('keeps the requested amount alongside what settled, when they differ', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store)

    const partial = JSON.stringify({
      Result: {
        ResultCode: 0,
        ResultDesc: 'ok',
        ConversationID: 'AG_B2B_1',
        ResultParameters: { ResultParameter: [{ Key: 'Amount', Value: 1200 }, { Key: 'TransactionID', Value: 'R1' }] },
      },
    })

    const { settled } = await billing.handleB2BResult(partial)

    expect(settled?.amount).toEqual({ currency: 'KES', minor: 150000 })
    expect(settled?.settledAmount).toEqual({ currency: 'KES', minor: 120000 })
  })

  it('handles a single ResultParameter that is not wrapped in an array', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store)

    const single = JSON.stringify({
      Result: {
        ResultCode: 0,
        ResultDesc: 'ok',
        ConversationID: 'AG_B2B_1',
        ResultParameters: { ResultParameter: { Key: 'TransactionReceipt', Value: 'SOLO1' } },
      },
    })

    expect((await billing.handleB2BResult(single)).settled?.receipt).toBe('SOLO1')
  })

  it('records a failure with the code Safaricom gave', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store)

    const { settled } = await billing.handleB2BResult(b2bResult('AG_B2B_1', 2001))

    expect(settled).toMatchObject({ status: 'FAILED', failureCode: '2001' })
  })

  it('does not let a late timeout overwrite a payout the result already settled', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store)

    await billing.handleB2BResult(b2bResult('AG_B2B_1'))
    const timeout = await billing.handleB2BTimeout(JSON.stringify({ ConversationID: 'AG_B2B_1' }))

    expect(timeout.settled).toBeNull()
    expect((await store.getPayment('b2b', 'AG_B2B_1'))?.status).toBe('SUCCESS')
  })

  it('marks a queue timeout FAILED when nothing else has settled it', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store)

    const { settled } = await billing.handleB2BTimeout(JSON.stringify({ ConversationID: 'AG_B2B_1' }))

    expect(settled).toMatchObject({ status: 'FAILED', failureCode: 'TIMEOUT' })
  })

  it('settles nothing for a ConversationID it never issued', async () => {
    const billing = new Billing({ store: new MemoryStore() })
    const result = await billing.handleB2BResult(b2bResult('AG_UNKNOWN'))

    expect(result.settled).toBeNull()
    expect(result.reply.status).toBe(200)
  })

  it('acknowledges an unparseable delivery instead of failing it', async () => {
    const billing = new Billing({ store: new MemoryStore() })
    expect((await billing.handleB2BResult('not json')).reply.status).toBe(200)
    expect((await billing.handleB2BTimeout('{}')).reply.status).toBe(200)
  })

  it('rolls the settlement back when applyOnSettle throws', async () => {
    const store = new MemoryStore()
    const billing = new Billing({
      store,
      applyOnSettle: async () => {
        throw new Error('ledger write failed')
      },
    })
    await seedPendingB2b(store)

    const result = await billing.handleB2BResult(b2bResult('AG_B2B_1'))

    expect(result.settled).toBeNull()
    expect((await store.getPayment('b2b', 'AG_B2B_1'))?.status).toBe('PENDING')
  })

  it('keeps B2B and B2C in separate namespaces even on the same ConversationID', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2b(store, 'AG_SHARED')
    await store.createPayment({
      id: 'b2c-1',
      rail: 'b2c',
      reference: 'REFUND-1',
      providerRef: 'AG_SHARED',
      amount: fromMajor(100, 'KES'),
      status: 'PENDING',
      createdAt: new Date(),
    })

    await billing.handleB2BResult(b2bResult('AG_SHARED'))

    expect((await store.getPayment('b2b', 'AG_SHARED'))?.status).toBe('SUCCESS')
    expect((await store.getPayment('b2c', 'AG_SHARED'))?.status).toBe('PENDING')
  })
})

describe('initiateB2B', () => {
  it('records a PENDING payment keyed on the ConversationID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/oauth/')
          ? Response.json({ access_token: 't', expires_in: '3599' })
          : Response.json({ ResponseCode: '0', ConversationID: 'AG_NEW', OriginatorConversationID: 'O' }),
      ),
    )

    const store = new MemoryStore()
    const billing = new Billing({ store, mpesa: { ...MPESA, securityCertificate: PUBLIC_PEM } })

    const { payment } = await billing.initiateB2B({
      reference: 'INV-9',
      receiverShortCode: '600000',
      amount: { amount: 2500, currency: 'KES' },
      accountReference: 'ACC-9',
      remarks: 'Invoice 9',
    })

    expect(payment).toMatchObject({
      rail: 'b2b',
      reference: 'INV-9',
      providerRef: 'AG_NEW',
      status: 'PENDING',
      payerRef: '600000',
      amount: { currency: 'KES', minor: 250000 },
    })
  })

  it('refuses to send in a currency M-PESA does not move', async () => {
    const billing = new Billing({
      store: new MemoryStore(),
      mpesa: { ...MPESA, securityCertificate: PUBLIC_PEM },
    })

    await expect(
      billing.initiateB2B({
        reference: 'INV-9',
        receiverShortCode: '600000',
        amount: { amount: '25.00', currency: 'USD' },
        accountReference: 'ACC-9',
        remarks: 'r',
      }),
    ).rejects.toThrow(/KES only/)
  })
})
