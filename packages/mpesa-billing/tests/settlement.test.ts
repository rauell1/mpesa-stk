import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { Billing } from '../src/billing.js'
import { MemoryStore } from '../src/adapters/memory.js'
import type { BillingPayment, StripeConfig } from '../src/types.js'

// The property that matters on every rail: N deliveries of the same payment
// settle it once, and the consequences fire once.

const STRIPE: StripeConfig = { secretKey: 'sk_test', webhookSecret: 'whsec_test' }

function stkCallback(checkoutRequestId: string, resultCode = 0): string {
  return JSON.stringify({
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-1',
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? 'ok' : 'Request cancelled by user',
        ...(resultCode === 0
          ? { CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' }] } }
          : {}),
      },
    },
  })
}

async function seedPendingStk(store: MemoryStore, providerRef: string): Promise<void> {
  await store.createPayment({
    id: 'pay-1',
    rail: 'stk',
    reference: 'ORDER-42',
    providerRef,
    amount: '500',
    currency: 'kes',
    status: 'PENDING',
    createdAt: new Date(),
  })
}

describe('STK callback settlement', () => {
  it('settles once and fires the hook once, however many times Daraja redelivers', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    const settled: BillingPayment[] = []
    billing.onPaymentSettled((payment) => {
      settled.push(payment)
    })

    await seedPendingStk(store, 'ws_CO_1')

    const first = await billing.handleStkCallback(stkCallback('ws_CO_1'))
    const second = await billing.handleStkCallback(stkCallback('ws_CO_1'))
    const third = await billing.handleStkCallback(stkCallback('ws_CO_1'))

    expect(first.settled?.status).toBe('SUCCESS')
    expect(first.settled?.receipt).toBe('NLJ7RT61SV')
    expect(first.duplicate).toBe(false)

    expect(second.settled).toBeNull()
    expect(second.duplicate).toBe(true)
    expect(third.settled).toBeNull()

    expect(settled).toHaveLength(1)
    // Safaricom is acknowledged either way — a non-200 would only bring the
    // same delivery back.
    for (const result of [first, second, third]) expect(result.reply.status).toBe(200)
  })

  it('records a cancelled payment as FAILED with the code Daraja gave', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingStk(store, 'ws_CO_2')

    const result = await billing.handleStkCallback(stkCallback('ws_CO_2', 1032))

    expect(result.settled).toMatchObject({ status: 'FAILED', failureCode: '1032' })
  })

  it('settles nothing for a CheckoutRequestID it never issued', async () => {
    const billing = new Billing({ store: new MemoryStore() })
    const result = await billing.handleStkCallback(stkCallback('ws_CO_unknown'))

    expect(result.settled).toBeNull()
    expect(result.reply.status).toBe(200)
  })

  it('acknowledges an unparseable delivery instead of failing it', async () => {
    const billing = new Billing({ store: new MemoryStore() })
    const result = await billing.handleStkCallback('not json at all')

    expect(result.reply.status).toBe(200)
    expect(result.settled).toBeNull()
  })

  it('rolls the settlement back when applyOnSettle throws', async () => {
    const store = new MemoryStore()
    const billing = new Billing({
      store,
      applyOnSettle: async () => {
        throw new Error('grant failed')
      },
    })
    await seedPendingStk(store, 'ws_CO_3')

    const result = await billing.handleStkCallback(stkCallback('ws_CO_3'))

    // The handler still answers 200, but the payment must not be left settled
    // with its consequence un-applied.
    expect(result.reply.status).toBe(200)
    expect(result.settled).toBeNull()
    expect((await store.getPayment('stk', 'ws_CO_3'))?.status).toBe('PENDING')
  })
})

describe('C2B confirmation', () => {
  const payload = JSON.stringify({
    TransID: 'RKTQDM7W6S',
    TransAmount: '500.00',
    BillRefNumber: 'ORDER-42',
    MSISDN: '254708374149',
    FirstName: 'John',
  })

  it('records the payment once, keyed on Safaricom receipt', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    const apply = vi.fn()
    billing.onPaymentSettled(apply)

    const first = await billing.handleC2BConfirmation(payload)
    const replay = await billing.handleC2BConfirmation(payload)

    expect(first.settled).toMatchObject({ rail: 'c2b', reference: 'ORDER-42', status: 'SUCCESS' })
    expect(replay.settled).toBeNull()
    expect(replay.duplicate).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(store.all()).toHaveLength(1)
  })

  it('acknowledges a malformed confirmation — the money has already moved', async () => {
    const billing = new Billing({ store: new MemoryStore() })
    const result = await billing.handleC2BConfirmation('{"TransID":"T1"}')

    expect(result.reply.status).toBe(200)
    expect(result.settled).toBeNull()
  })
})

describe('C2B validation', () => {
  it('declines an account number the application does not recognise', async () => {
    const billing = new Billing({
      store: new MemoryStore(),
      validateC2BReference: (reference) => reference === 'ORDER-42',
    })

    const accepted = await billing.handleC2BValidation(
      JSON.stringify({ TransID: 'T1', TransAmount: '1', BillRefNumber: 'ORDER-42', MSISDN: 'x' }),
    )
    const declined = await billing.handleC2BValidation(
      JSON.stringify({ TransID: 'T2', TransAmount: '1', BillRefNumber: 'NOPE', MSISDN: 'x' }),
    )

    expect(accepted.reply.body).toMatchObject({ ResultCode: '0' })
    // A rejection is still HTTP 200 — a non-200 reads as "validator down".
    expect(declined.reply.status).toBe(200)
    expect(declined.reply.body).toMatchObject({ ResultCode: 'C2B00012' })
  })

  it('declines rather than accepts when the validator itself throws', async () => {
    const billing = new Billing({
      store: new MemoryStore(),
      validateC2BReference: () => {
        throw new Error('database down')
      },
    })

    const result = await billing.handleC2BValidation(
      JSON.stringify({ TransID: 'T1', TransAmount: '1', BillRefNumber: 'ORDER-42', MSISDN: 'x' }),
    )

    expect(result.reply.status).toBe(200)
    expect(result.reply.body).toMatchObject({ ResultCode: 'C2B00016' })
  })
})

describe('B2C', () => {
  async function seedPendingB2c(store: MemoryStore): Promise<void> {
    await store.createPayment({
      id: 'payout-1',
      rail: 'b2c',
      reference: 'REFUND-7',
      providerRef: 'AG_1',
      amount: '250',
      currency: 'kes',
      status: 'PENDING',
      createdAt: new Date(),
    })
  }

  it('settles a payout from the result callback', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2c(store)

    const result = await billing.handleB2CResult(
      JSON.stringify({ Result: { ResultCode: 0, ResultDesc: 'ok', ConversationID: 'AG_1', TransactionID: 'NLJ41HAY6Q' } }),
    )

    expect(result.settled).toMatchObject({ status: 'SUCCESS', receipt: 'NLJ41HAY6Q' })
  })

  it('does not let a late timeout overwrite a payout the result already settled', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    await seedPendingB2c(store)

    await billing.handleB2CResult(
      JSON.stringify({ Result: { ResultCode: 0, ResultDesc: 'ok', ConversationID: 'AG_1' } }),
    )
    const timeout = await billing.handleB2CTimeout(JSON.stringify({ ConversationID: 'AG_1' }))

    expect(timeout.settled).toBeNull()
    expect((await store.getPayment('b2c', 'AG_1'))?.status).toBe('SUCCESS')
  })
})

describe('Stripe webhook', () => {
  function signed(body: string, secret = STRIPE.webhookSecret): string {
    const t = Math.floor(Date.now() / 1000)
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
  }

  const completed = JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        client_reference_id: 'ORDER-42',
        payment_status: 'paid',
        payment_intent: 'pi_1',
      },
    },
  })

  async function seedPendingStripe(store: MemoryStore): Promise<void> {
    await store.createPayment({
      id: 'stripe-1',
      rail: 'stripe',
      reference: 'ORDER-42',
      providerRef: 'cs_test_1',
      amount: '2000',
      currency: 'usd',
      status: 'PENDING',
      createdAt: new Date(),
    })
  }

  it('settles once across redeliveries', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, stripe: STRIPE })
    await seedPendingStripe(store)

    const first = await billing.handleStripeWebhook(completed, signed(completed))
    const second = await billing.handleStripeWebhook(completed, signed(completed))

    expect(first.settled).toMatchObject({ status: 'SUCCESS', receipt: 'pi_1' })
    expect(second.settled).toBeNull()
    expect(second.reply.status).toBe(200)
  })

  it('rejects an unsigned delivery with 400 and settles nothing', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, stripe: STRIPE })
    await seedPendingStripe(store)

    const result = await billing.handleStripeWebhook(completed, null)

    expect(result.reply.status).toBe(400)
    expect(result.settled).toBeNull()
    expect((await store.getPayment('stripe', 'cs_test_1'))?.status).toBe('PENDING')
  })

  it('rejects a forged delivery signed with the wrong secret', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, stripe: STRIPE })
    await seedPendingStripe(store)

    const result = await billing.handleStripeWebhook(completed, signed(completed, 'whsec_attacker'))

    expect(result.reply.status).toBe(400)
    expect((await store.getPayment('stripe', 'cs_test_1'))?.status).toBe('PENDING')
  })

  it('waits for the money on an async method, where the session completes unpaid', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, stripe: STRIPE })
    await seedPendingStripe(store)

    const unpaid = JSON.stringify({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', client_reference_id: 'ORDER-42', payment_status: 'unpaid' } },
    })

    const pending = await billing.handleStripeWebhook(unpaid, signed(unpaid))
    expect(pending.settled).toBeNull()
    expect((await store.getPayment('stripe', 'cs_test_1'))?.status).toBe('PENDING')

    const succeeded = JSON.stringify({
      id: 'evt_3',
      type: 'checkout.session.async_payment_succeeded',
      data: { object: { id: 'cs_test_1', client_reference_id: 'ORDER-42', payment_intent: { id: 'pi_2' } } },
    })

    const settled = await billing.handleStripeWebhook(succeeded, signed(succeeded))
    expect(settled.settled).toMatchObject({ status: 'SUCCESS', receipt: 'pi_2' })
  })

  it('marks an expired session FAILED', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, stripe: STRIPE })
    await seedPendingStripe(store)

    const expired = JSON.stringify({
      id: 'evt_4',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_test_1', client_reference_id: 'ORDER-42' } },
    })

    const result = await billing.handleStripeWebhook(expired, signed(expired))
    expect(result.settled).toMatchObject({ status: 'FAILED', failureCode: 'checkout.session.expired' })
  })

  it('ignores event types it does not handle', async () => {
    const billing = new Billing({ store: new MemoryStore(), stripe: STRIPE })
    const other = JSON.stringify({ id: 'evt_5', type: 'customer.created', data: { object: { id: 'cus_1' } } })

    const result = await billing.handleStripeWebhook(other, signed(other))
    expect(result.reply.status).toBe(200)
    expect(result.settled).toBeNull()
  })
})

describe('onPaymentSettled', () => {
  it('does not let a throwing listener turn into a redelivery', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })
    billing.onPaymentSettled(() => {
      throw new Error('email service down')
    })
    await seedPendingStk(store, 'ws_CO_9')

    const result = await billing.handleStkCallback(stkCallback('ws_CO_9'))

    expect(result.reply.status).toBe(200)
    expect(result.settled?.status).toBe('SUCCESS')
  })
})
