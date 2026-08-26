import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { Billing } from '../src/billing.js'
import { MemoryStore } from '../src/adapters/memory.js'
import {
  SAFARICOM_CALLBACK_CIDRS,
  darajaConfigFromEnv,
  isIpAllowed,
  normalisePem,
  securityCredential,
} from '../src/config.js'
import { createWebhookRoutes } from '../src/next.js'
import { decryptPkcs1v15 } from './helpers/pkcs1.js'

// Safaricom signs nothing. Two things stand in for a signature: the published
// callback IP ranges, and — for payouts — a certificate that has to survive
// the trip through an environment variable.

const KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString()

describe('normalisePem', () => {
  it('repairs a PEM whose newlines arrived as the two characters \\ and n', () => {
    // How Docker, Kubernetes, Vercel, and GitHub Actions hand over a secret.
    const escaped = PEM.replace(/\n/g, '\\n')
    expect(escaped).not.toContain('\n')
    expect(normalisePem(escaped)).toBe(PEM.trim() + '\n')
  })

  it('leaves a PEM that already has real newlines alone', () => {
    expect(normalisePem(PEM)).toBe(PEM.trim() + '\n')
  })

  it('handles \\r\\n from a Windows-authored secret', () => {
    expect(normalisePem(PEM.replace(/\n/g, '\r\n'))).toBe(PEM.trim() + '\n')
  })

  it('rejects something that is not a PEM at all, naming the real problem', () => {
    expect(() => normalisePem('not-a-certificate')).toThrow(/not PEM/)
  })
})

describe('securityCredential', () => {
  it('encrypts the initiator password under an escaped certificate — the deployment case', () => {
    const credential = securityCredential('Safaricom999!*!', PEM.replace(/\n/g, '\\n'))
    const privateKeyPem = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

    expect(decryptPkcs1v15(privateKeyPem, credential)).toBe('Safaricom999!*!')
  })
})

describe('darajaConfigFromEnv', () => {
  const base = {
    MPESA_CONSUMER_KEY: 'ck',
    MPESA_CONSUMER_SECRET: 'cs',
    MPESA_SHORTCODE: '174379',
    MPESA_PASSKEY: 'pk',
    MPESA_CALLBACK_BASE_URL: 'https://app.example.com',
  }

  it('normalises the certificate at boot, so a bad one fails before the first payout', () => {
    const config = darajaConfigFromEnv({ ...base, MPESA_SECURITY_CERTIFICATE: PEM.replace(/\n/g, '\\n') })
    expect(config.securityCertificate).toContain('\n')
    expect(config.securityCertificate).not.toContain('\\n')
  })

  it('rejects a shortcode that is not a shortcode', () => {
    expect(() => darajaConfigFromEnv({ ...base, MPESA_SHORTCODE: '254712345678' })).toThrow(/MPESA_SHORTCODE/)
  })

  it('rejects a non-numeric timeout instead of silently using NaN', () => {
    expect(() => darajaConfigFromEnv({ ...base, MPESA_TIMEOUT_MS: 'soon' })).toThrow(/positive number/)
  })
})

describe('isIpAllowed', () => {
  // Note the CIDR arithmetic: 196.201.214.200/28 is written around .200 but
  // masks to the .192-.207 block, so .199 is inside it and .215 is not. The
  // block, not the address Safaricom happened to write down, is what counts.
  it.each([
    '196.201.214.192',
    '196.201.214.200',
    '196.201.214.206',
    '196.201.214.207',
    '196.201.214.216',
    '196.201.214.223',
    '196.201.214.232',
    '196.201.214.236',
    '196.201.214.240',
    '196.201.214.243',
    '196.201.214.246',
  ])('accepts %s, which is inside a published block', (ip) => {
    expect(isIpAllowed(ip, SAFARICOM_CALLBACK_CIDRS)).toBe(true)
  })

  it.each([
    '196.201.214.191',
    '196.201.214.208',
    '196.201.214.215',
    '196.201.214.224',
    '196.201.214.237',
    '196.201.214.245',
    '196.201.214.247',
    '196.201.215.200',
    '127.0.0.1',
    '8.8.8.8',
  ])('rejects %s', (ip) => {
    expect(isIpAllowed(ip, SAFARICOM_CALLBACK_CIDRS)).toBe(false)
  })

  it('unwraps an IPv4-mapped IPv6 address, which is how Node reports one', () => {
    expect(isIpAllowed('::ffff:196.201.214.200', SAFARICOM_CALLBACK_CIDRS)).toBe(true)
  })

  it.each([undefined, '', 'not-an-ip', '999.1.1.1', '196.201.214'])('rejects %s', (ip) => {
    expect(isIpAllowed(ip, SAFARICOM_CALLBACK_CIDRS)).toBe(false)
  })

  it('handles a bare address with no prefix length', () => {
    expect(isIpAllowed('10.0.0.1', ['10.0.0.1'])).toBe(true)
    expect(isIpAllowed('10.0.0.2', ['10.0.0.1'])).toBe(false)
  })
})

describe('trustedMpesaIps', () => {
  const confirmation = JSON.stringify({
    TransID: 'FORGED1',
    TransAmount: '10000',
    BillRefNumber: 'ORDER-42',
    MSISDN: '254708374149',
  })

  it('records nothing when a C2B confirmation comes from an untrusted address', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })

    const result = await billing.handleC2BConfirmation(confirmation, { sourceIp: '203.0.113.9' })

    expect(result.settled).toBeNull()
    expect(await store.getPayment('c2b', 'FORGED1')).toBeNull()
    // Still a 200: an attacker learns nothing, and a real retry is harmless.
    expect(result.reply.status).toBe(200)
  })

  it('records it when the address is one of Safaricom’s', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })

    const result = await billing.handleC2BConfirmation(confirmation, { sourceIp: '196.201.214.206' })

    expect(result.settled).toMatchObject({ reference: 'ORDER-42', status: 'SUCCESS' })
  })

  it('rejects a delivery that carries no source IP at all when the check is on', async () => {
    const billing = new Billing({ store: new MemoryStore(), trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })
    expect((await billing.handleC2BConfirmation(confirmation)).settled).toBeNull()
  })

  it('declines C2B validation from an untrusted address rather than accepting the payment', async () => {
    const billing = new Billing({ store: new MemoryStore(), trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })
    const result = await billing.handleC2BValidation(confirmation, { sourceIp: '203.0.113.9' })

    expect(result.reply.body).toMatchObject({ ResultCode: 'C2B00016' })
  })

  it('makes no check at all when the option is unset — the default stays permissive', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store })

    expect((await billing.handleC2BConfirmation(confirmation, { sourceIp: '203.0.113.9' })).settled).not.toBeNull()
  })

  it('guards every M-PESA rail, not only C2B', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })
    await store.createPayment({
      id: 'p1',
      rail: 'stk',
      reference: 'ORDER-1',
      providerRef: 'ws_CO_1',
      amount: { currency: 'KES', minor: 50000 },
      status: 'PENDING',
      createdAt: new Date(),
    })

    const forged = JSON.stringify({
      Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok' } },
    })

    expect((await billing.handleStkCallback(forged, { sourceIp: '203.0.113.9' })).settled).toBeNull()
    expect((await store.getPayment('stk', 'ws_CO_1'))?.status).toBe('PENDING')
  })
})

describe('createWebhookRoutes source IP', () => {
  it('reads the first entry of x-forwarded-for', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })
    const routes = createWebhookRoutes(billing)

    const body = JSON.stringify({
      TransID: 'T1',
      TransAmount: '100',
      BillRefNumber: 'ORDER-42',
      MSISDN: '254708374149',
    })

    await routes.c2bConfirmation(
      new Request('https://app.example.com/api/webhooks/mpesa/c2b/confirmation', {
        method: 'POST',
        body,
        headers: { 'x-forwarded-for': '196.201.214.206, 10.0.0.1' },
      }),
    )

    expect(await store.getPayment('c2b', 'T1')).not.toBeNull()
  })

  it('can be pointed at a different header', async () => {
    const store = new MemoryStore()
    const billing = new Billing({ store, trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS })
    const routes = createWebhookRoutes(billing, { sourceIpHeader: 'cf-connecting-ip' })

    await routes.c2bConfirmation(
      new Request('https://app.example.com/x', {
        method: 'POST',
        body: JSON.stringify({ TransID: 'T2', TransAmount: '100', BillRefNumber: 'R', MSISDN: 'x' }),
        headers: { 'cf-connecting-ip': '196.201.214.240' },
      }),
    )

    expect(await store.getPayment('c2b', 'T2')).not.toBeNull()
  })

  it('exposes the B2B routes alongside the rest', () => {
    const routes = createWebhookRoutes(new Billing({ store: new MemoryStore() }))
    expect(typeof routes.b2bResult).toBe('function')
    expect(typeof routes.b2bTimeout).toBe('function')
  })
})
