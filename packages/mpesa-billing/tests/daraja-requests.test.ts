import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync, X509Certificate } from 'node:crypto'
import { MemoryStore } from '../src/adapters/memory.js'
import {
  b2bPaymentRequest,
  b2cPaymentRequest,
  getAccessToken,
  registerC2BUrls,
  stkPush,
} from '../src/daraja.js'
import { fromMajor } from '../src/money.js'
import { decryptPkcs1v15 } from './helpers/pkcs1.js'
import type { DarajaConfig } from '../src/types.js'

// The outbound half: what actually goes on the wire. These are the fields that
// fail as a generic "invalid request" when they are wrong, which is why they
// are asserted one by one rather than as a whole-body snapshot.

/** A throwaway certificate so SecurityCredential can be decrypted and checked. */
function selfSignedCertificate(): { pem: string; privateKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  // A certificate needs a CA to sign it; for these tests the public key alone
  // is what publicEncrypt consumes, and PEM-wrapping it is enough.
  void publicKey
  void X509Certificate
  return {
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const CERT = selfSignedCertificate()

const CONFIG: DarajaConfig = {
  consumerKey: 'ck',
  consumerSecret: 'cs',
  shortCode: '174379',
  passKey: 'pk',
  environment: 'sandbox',
  callbackBaseUrl: 'https://app.example.com/',
  initiatorName: 'testapi',
  initiatorPassword: 'Safaricom999!*!',
  securityCertificate: CERT.pem,
}

interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

let calls: Call[] = []

function mockFetch(responder: (url: string) => { status?: number; body: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {}
      calls.push({ url, init, body })
      const { status = 200, body: responseBody } = responder(url)
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

/** Every call needs a token first; this answers that and then the real call. */
function respondWith(payload: unknown, status = 200): (url: string) => { status?: number; body: unknown } {
  return (url) =>
    url.includes('/oauth/')
      ? { body: { access_token: 'tok-1', expires_in: '3599' } }
      : { status, body: payload }
}

function lastCall(): Call {
  const call = calls[calls.length - 1]
  if (!call) throw new Error('no fetch call was made')
  return call
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getAccessToken', () => {
  it('caches the token in the store instead of minting one per request', async () => {
    const store = new MemoryStore()
    mockFetch(respondWith({}))

    await getAccessToken(CONFIG, store)
    await getAccessToken(CONFIG, store)

    expect(calls.filter((c) => c.url.includes('/oauth/'))).toHaveLength(1)
  })

  it('sends the consumer key and secret as HTTP Basic', async () => {
    mockFetch(respondWith({}))
    await getAccessToken(CONFIG, new MemoryStore())

    const auth = (lastCall().init.headers as Record<string, string>)['Authorization']
    expect(auth).toBe(`Basic ${Buffer.from('ck:cs').toString('base64')}`)
  })

  it('re-mints once the cached token is inside the expiry margin', async () => {
    const store = new MemoryStore()
    await store.putCachedToken('sandbox', {
      accessToken: 'stale',
      expiresAt: new Date(Date.now() + 30_000), // inside the 60s margin
    })
    mockFetch(respondWith({}))

    expect(await getAccessToken(CONFIG, store)).toBe('tok-1')
  })

  it('throws with the HTTP status when Daraja rejects the credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad creds', { status: 400 })))
    await expect(getAccessToken(CONFIG, new MemoryStore())).rejects.toThrow(/HTTP 400/)
  })
})

describe('stkPush', () => {
  it('sends whole shillings, a normalised MSISDN, and the built callback URL', async () => {
    mockFetch(respondWith({ CheckoutRequestID: 'ws_CO_1', CustomerMessage: 'ok' }))

    await stkPush(CONFIG, new MemoryStore(), {
      phoneNumber: '0712345678',
      amount: fromMajor(500, 'KES'),
      accountReference: 'ORDER-1234567890',
      description: 'A long description',
    })

    const { url, body } = lastCall()
    expect(url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest')
    expect(body['Amount']).toBe(500)
    expect(body['PartyA']).toBe('254712345678')
    expect(body['PhoneNumber']).toBe('254712345678')
    expect(body['BusinessShortCode']).toBe('174379')
    expect(body['CallBackURL']).toBe('https://app.example.com/api/webhooks/mpesa')
    // Daraja truncates these itself; doing it here keeps the request valid.
    expect(body['AccountReference']).toBe('ORDER-123456')
    expect(body['TransactionDesc']).toBe('A long descri')
  })

  it('refuses a non-KES amount before it reaches Daraja', async () => {
    mockFetch(respondWith({ CheckoutRequestID: 'x' }))
    await expect(
      stkPush(CONFIG, new MemoryStore(), {
        phoneNumber: '0712345678',
        amount: fromMajor('5.00', 'USD'),
        accountReference: 'R',
        description: 'd',
      }),
    ).rejects.toThrow(/KES only/)
  })

  it('supports a till via CustomerBuyGoodsOnline', async () => {
    mockFetch(respondWith({ CheckoutRequestID: 'ws_CO_1', CustomerMessage: 'ok' }))
    await stkPush(CONFIG, new MemoryStore(), {
      phoneNumber: '0712345678',
      amount: fromMajor(10, 'KES'),
      accountReference: 'R',
      description: 'd',
      transactionType: 'CustomerBuyGoodsOnline',
    })
    expect(lastCall().body['TransactionType']).toBe('CustomerBuyGoodsOnline')
  })

  it('throws when Daraja answers with an errorCode instead of a CheckoutRequestID', async () => {
    mockFetch(respondWith({ errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid Amount' }, 400))
    await expect(
      stkPush(CONFIG, new MemoryStore(), {
        phoneNumber: '0712345678',
        amount: fromMajor(1, 'KES'),
        accountReference: 'R',
        description: 'd',
      }),
    ).rejects.toThrow(/Invalid Amount/)
  })
})

describe('registerC2BUrls', () => {
  it('defaults to Cancelled — an unreachable validator must not take money', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ResponseDescription: 'success' }))
    await registerC2BUrls(CONFIG, new MemoryStore())

    const { body } = lastCall()
    expect(body['ResponseType']).toBe('Cancelled')
    expect(body['ValidationURL']).toBe('https://app.example.com/api/webhooks/mpesa/c2b/validation')
    expect(body['ConfirmationURL']).toBe('https://app.example.com/api/webhooks/mpesa/c2b/confirmation')
  })
})

describe('b2cPaymentRequest', () => {
  it('sends InitiatorName and an encrypted SecurityCredential', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'AG_1', OriginatorConversationID: 'O_1' }))

    await b2cPaymentRequest(CONFIG, new MemoryStore(), {
      phoneNumber: '0712345678',
      amount: fromMajor(250, 'KES'),
      remarks: 'Refund',
    })

    const { url, body } = lastCall()
    expect(url).toBe('https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest')
    expect(body['InitiatorName']).toBe('testapi')
    expect(body['CommandID']).toBe('BusinessPayment')
    expect(body['Amount']).toBe(250)
    expect(body['PartyA']).toBe('174379')
    expect(body['PartyB']).toBe('254712345678')
    expect(body['ResultURL']).toBe('https://app.example.com/api/webhooks/mpesa/b2c/result')
    expect(body['QueueTimeOutURL']).toBe('https://app.example.com/api/webhooks/mpesa/b2c/timeout')

    // The credential must be the initiator password, RSA-encrypted.
    expect(decryptPkcs1v15(CERT.privateKey, String(body['SecurityCredential']))).toBe('Safaricom999!*!')
  })

  it('refuses to send without the payout credentials', async () => {
    mockFetch(respondWith({}))
    const { initiatorName: _n, initiatorPassword: _p, securityCertificate: _c, ...bare } = CONFIG
    await expect(
      b2cPaymentRequest(bare, new MemoryStore(), {
        phoneNumber: '0712345678',
        amount: fromMajor(1, 'KES'),
        remarks: 'r',
      }),
    ).rejects.toThrow(/B2C requires initiatorName/)
  })
})

describe('b2bPaymentRequest', () => {
  it('uses the B2B wire format, which differs from B2C in three ways', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'AG_B2B_1', OriginatorConversationID: 'O_1' }))

    await b2bPaymentRequest(CONFIG, new MemoryStore(), {
      receiverShortCode: '600000',
      amount: fromMajor(1500, 'KES'),
      accountReference: 'INV-2026-001',
      remarks: 'Supplier invoice',
    })

    const { url, body } = lastCall()
    expect(url).toBe('https://sandbox.safaricom.co.ke/mpesa/b2b/v1/paymentrequest')

    // 1. The operator field is `Initiator`, not `InitiatorName`.
    expect(body['Initiator']).toBe('testapi')
    expect(body['InitiatorName']).toBeUndefined()

    // 2. PartyB is a shortcode, not a phone number — no MSISDN normalisation.
    expect(body['PartyA']).toBe('174379')
    expect(body['PartyB']).toBe('600000')

    // 3. Safaricom's own field is misspelled, and the wire format is the
    //    authority on that.
    expect(body['RecieverIdentifierType']).toBe('4')
    expect(body['ReceiverIdentifierType']).toBeUndefined()

    expect(body['SenderIdentifierType']).toBe('4')
    expect(body['CommandID']).toBe('BusinessPayBill')
    expect(body['Amount']).toBe(1500)
    expect(body['AccountReference']).toBe('INV-2026-001')
    expect(body['ResultURL']).toBe('https://app.example.com/api/webhooks/mpesa/b2b/result')
    expect(body['QueueTimeOutURL']).toBe('https://app.example.com/api/webhooks/mpesa/b2b/timeout')
  })

  it('requires an accountReference for BusinessPayBill — Daraja rejects it without one', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'x' }))
    await expect(
      b2bPaymentRequest(CONFIG, new MemoryStore(), {
        receiverShortCode: '600000',
        amount: fromMajor(10, 'KES'),
        remarks: 'r',
      }),
    ).rejects.toThrow(/requires an accountReference/)
  })

  it('does not require an accountReference for a till', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'AG_1' }))

    await b2bPaymentRequest(CONFIG, new MemoryStore(), {
      receiverShortCode: '600000',
      amount: fromMajor(10, 'KES'),
      remarks: 'Buy goods',
      commandId: 'BusinessBuyGoods',
      receiverIdentifierType: '2',
    })

    const { body } = lastCall()
    expect(body['CommandID']).toBe('BusinessBuyGoods')
    expect(body['RecieverIdentifierType']).toBe('2')
  })

  it('normalises the optional Requester MSISDN but never PartyB', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'AG_1' }))

    await b2bPaymentRequest(CONFIG, new MemoryStore(), {
      receiverShortCode: '600000',
      amount: fromMajor(10, 'KES'),
      accountReference: 'ACC',
      remarks: 'r',
      requesterPhoneNumber: '0712345678',
    })

    const { body } = lastCall()
    expect(body['Requester']).toBe('254712345678')
    expect(body['PartyB']).toBe('600000')
  })

  it('rejects a receiver that is not a shortcode — a phone number here is a real mistake', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'x' }))
    await expect(
      b2bPaymentRequest(CONFIG, new MemoryStore(), {
        receiverShortCode: '254712345678',
        amount: fromMajor(10, 'KES'),
        accountReference: 'ACC',
        remarks: 'r',
      }),
    ).rejects.toThrow(/not a valid receiverShortCode/)
  })

  it('refuses a non-KES payout', async () => {
    mockFetch(respondWith({ ResponseCode: '0', ConversationID: 'x' }))
    await expect(
      b2bPaymentRequest(CONFIG, new MemoryStore(), {
        receiverShortCode: '600000',
        amount: fromMajor('5.00', 'USD'),
        accountReference: 'ACC',
        remarks: 'r',
      }),
    ).rejects.toThrow(/KES only/)
  })

  it('throws when Daraja does not accept the request for processing', async () => {
    mockFetch(respondWith({ ResponseCode: '1', ResponseDescription: 'Initiator information is invalid' }, 500))
    await expect(
      b2bPaymentRequest(CONFIG, new MemoryStore(), {
        receiverShortCode: '600000',
        amount: fromMajor(10, 'KES'),
        accountReference: 'ACC',
        remarks: 'r',
      }),
    ).rejects.toThrow(/Initiator information is invalid/)
  })
})

describe('live vs sandbox', () => {
  it('points at api.safaricom.co.ke when the environment is live', async () => {
    mockFetch(respondWith({ CheckoutRequestID: 'x', CustomerMessage: 'ok' }))
    await stkPush({ ...CONFIG, environment: 'live' }, new MemoryStore(), {
      phoneNumber: '0712345678',
      amount: fromMajor(1, 'KES'),
      accountReference: 'R',
      description: 'd',
    })
    expect(lastCall().url).toBe('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest')
  })
})
