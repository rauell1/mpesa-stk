/**
 * Daraja sandbox smoke test — the thing the unit tests cannot do.
 *
 * Every outbound test in this repository asserts what we *believe* Daraja
 * wants, against a mocked `fetch`. If that belief is wrong, the test encodes
 * the same wrong belief and passes. This script removes the belief: it sends
 * the library's real requests to Safaricom's real sandbox and reports, rail by
 * rail, what Daraja actually did with them.
 *
 * It exercises the library's own functions — not a reimplementation — so a
 * pass here is evidence about the shipped code path. The two exceptions are
 * marked SANDBOX HELPER: the STK Query and the C2B simulate endpoint, which
 * this package does not wrap but which are needed to provoke a real callback.
 *
 * Everything Daraja sends back is written to ./captured/ verbatim, so a real
 * response can replace a hand-written test fixture.
 *
 * Run:
 *   npm run sandbox:sink     # terminal 1, then tunnel it
 *   npm run sandbox:smoke    # terminal 2
 *
 * See ./README.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Billing } from '../../packages/mpesa-billing/src/billing.js'
import { MemoryStore } from '../../packages/mpesa-billing/src/adapters/memory.js'
import {
  baseUrl,
  darajaConfigFromEnv,
  eatTimestamp,
  stkPassword,
} from '../../packages/mpesa-billing/src/config.js'
import { getAccessToken } from '../../packages/mpesa-billing/src/daraja.js'
import type { BillingStore } from '../../packages/mpesa-billing/src/adapters/types.js'
import type { DarajaConfig } from '../../packages/mpesa-billing/src/types.js'

/**
 * Where captured payloads go. Resolved from the working directory rather than
 * `import.meta.dirname`, which is unavailable in this package's CommonJS module
 * mode — and npm always runs a script from the package root, which is also
 * where `npx tsx scripts/...` is invoked from.
 */
const CAPTURED = join(process.cwd(), 'scripts', 'sandbox', 'captured')

// KES 1. Sandbox money is not real, but keeping it at the floor means a
// misconfigured run pointed at production costs one shilling, not a payroll.
const AMOUNT = { amount: 1, currency: 'KES' } as const

type Status = 'PASS' | 'FAIL' | 'SKIP'

interface Result {
  name: string
  status: Status
  detail: string
  /** What Daraja actually returned, for the summary and for ./captured/. */
  evidence?: unknown
}

const results: Result[] = []

function record(name: string, status: Status, detail: string, evidence?: unknown): void {
  results.push({ name, status, detail, ...(evidence !== undefined ? { evidence } : {}) })
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '–'
  console.log(`${mark} ${name.padEnd(26)} ${detail}`)
  if (evidence !== undefined) capture(name, evidence)
}

function capture(name: string, payload: unknown): void {
  mkdirSync(CAPTURED, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(
    join(CAPTURED, `${stamp}__${name}.json`),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  )
}

/** Run one check, turning any throw into a FAIL with Daraja's own words. */
async function check(
  name: string,
  run: () => Promise<{ detail: string; evidence?: unknown }>,
): Promise<boolean> {
  try {
    const { detail, evidence } = await run()
    record(name, 'PASS', detail, evidence)
    return true
  } catch (error) {
    // The message matters more than the stack: Daraja's errors are the finding.
    record(name, 'FAIL', error instanceof Error ? error.message : String(error))
    return false
  }
}

function skip(name: string, why: string): void {
  record(name, 'SKIP', why)
}

// ---------------------------------------------------------------------------
// Sandbox helpers — endpoints this package does not wrap
// ---------------------------------------------------------------------------

/**
 * SANDBOX HELPER: STK Query. Confirms the push Daraja acknowledged actually
 * exists on their side, without waiting for the callback.
 */
async function stkQuery(
  config: DarajaConfig,
  store: BillingStore,
  checkoutRequestId: string,
): Promise<unknown> {
  const timestamp = eatTimestamp()
  const token = await getAccessToken(config, store)

  const res = await fetch(`${baseUrl(config.environment)}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      BusinessShortCode: config.shortCode,
      Password: stkPassword(config.shortCode, config.passKey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`STK Query returned HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

/**
 * SANDBOX HELPER: C2B simulate. Sandbox-only — it makes Safaricom act as a
 * customer paying the shortcode, which is the only way to provoke a genuine
 * validation + confirmation callback pair. There is no production equivalent;
 * in production a real person pays the till.
 */
async function c2bSimulate(
  config: DarajaConfig,
  store: BillingStore,
  reference: string,
): Promise<unknown> {
  const token = await getAccessToken(config, store)

  const res = await fetch(`${baseUrl(config.environment)}/mpesa/c2b/v1/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ShortCode: config.shortCode,
      CommandID: 'CustomerPayBillOnline',
      Amount: 1,
      Msisdn: process.env['MPESA_TEST_MSISDN'] ?? '254708374149',
      BillRefNumber: reference,
    }),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`C2B simulate returned HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = darajaConfigFromEnv()

  // Refuse to run against production. Every rail below moves money, and B2C
  // and B2B move it *out* — a mistyped environment variable should not be able
  // to pay a stranger.
  if (config.environment !== 'sandbox') {
    console.error(
      `\nRefusing to run: MPESA_ENVIRONMENT is '${config.environment}'.\n` +
        'This script initiates payments and payouts. It only runs against the sandbox.\n',
    )
    process.exit(2)
  }

  const testMsisdn = process.env['MPESA_TEST_MSISDN'] ?? '254708374149'
  const reference = `SMOKE-${Date.now().toString(36).toUpperCase()}`

  console.log('\nDaraja sandbox smoke test')
  console.log('─'.repeat(64))
  console.log(`shortcode   ${config.shortCode}`)
  console.log(`callbacks   ${config.callbackBaseUrl}`)
  console.log(`test msisdn ${testMsisdn}`)
  console.log(`reference   ${reference}`)
  console.log(`amount      KES 1 per rail`)
  console.log('─'.repeat(64) + '\n')

  if (config.callbackBaseUrl.includes('localhost') || config.callbackBaseUrl.startsWith('http://')) {
    console.log(
      'Note: MPESA_CALLBACK_BASE_URL is not a public https:// origin. Outbound\n' +
        '      calls will still be verified, but Safaricom cannot deliver callbacks\n' +
        '      to it, so nothing will land in the sink. Tunnel it to see the\n' +
        '      inbound half.\n',
    )
  }

  const store = new MemoryStore()
  const billing = new Billing({ store, mpesa: config })

  // 1. Auth. Everything else is meaningless if this fails.
  const authed = await check('oauth', async () => {
    const token = await getAccessToken(config, store)
    return { detail: `token acquired (${token.length} chars)` }
  })

  if (!authed) {
    console.log('\nStopping: without a token no other rail can be tested.\n')
    summarise()
    process.exit(1)
  }

  // 2. STK Push — the customer-initiated rail.
  let checkoutRequestId: string | undefined
  await check('stk-push', async () => {
    const { payment, customerMessage } = await billing.initiateStkPush({
      reference,
      phoneNumber: testMsisdn,
      amount: AMOUNT,
      accountReference: reference.slice(0, 12),
      description: 'Smoke test',
    })
    checkoutRequestId = payment.providerRef
    return {
      detail: `accepted, CheckoutRequestID ${payment.providerRef}`,
      evidence: { providerRef: payment.providerRef, customerMessage, amount: payment.amount },
    }
  })

  // 3. STK Query — proves the push exists on Daraja's side, not just ours.
  if (checkoutRequestId) {
    // Daraja rejects a query issued before it has processed the push.
    await new Promise((resolve) => setTimeout(resolve, 8000))
    await check('stk-query', async () => {
      const body = await stkQuery(config, store, checkoutRequestId!)
      return { detail: `queried; ${describe(body)}`, evidence: body }
    })
  } else {
    skip('stk-query', 'no CheckoutRequestID — the push did not succeed')
  }

  // 4. C2B URL registration.
  const registered = await check('c2b-register', async () => {
    const body = await billing.registerC2BUrls()
    return { detail: describe(body), evidence: body }
  })

  // 5. C2B simulate — provokes a real validation + confirmation callback.
  if (registered) {
    await check('c2b-simulate', async () => {
      const body = await c2bSimulate(config, store, reference)
      return { detail: `${describe(body)} — watch the sink for callbacks`, evidence: body }
    })
  } else {
    skip('c2b-simulate', 'registration failed, so callbacks would go nowhere')
  }

  // 6 & 7. The payout rails. Both need an operator identity.
  const canPayOut = Boolean(
    config.initiatorName && config.initiatorPassword && config.securityCertificate,
  )

  if (!canPayOut) {
    const why = 'set MPESA_INITIATOR_NAME, MPESA_INITIATOR_PASSWORD, MPESA_SECURITY_CERTIFICATE'
    skip('b2c', why)
    skip('b2b', why)
  } else {
    await check('b2c', async () => {
      const { payment, response } = await billing.initiateB2C({
        reference,
        phoneNumber: testMsisdn,
        amount: AMOUNT,
        remarks: 'Smoke test payout',
      })
      return {
        detail: `queued, ConversationID ${payment.providerRef}`,
        evidence: response,
      }
    })

    // B2B is the least-proven rail in this repository: its wire format was
    // inferred from documentation and has never been confirmed by Daraja.
    // This check is the point of the whole script.
    const receiver = process.env['MPESA_TEST_RECEIVER_SHORTCODE']
    if (!receiver) {
      skip('b2b', 'set MPESA_TEST_RECEIVER_SHORTCODE to a second sandbox shortcode')
    } else {
      await check('b2b', async () => {
        const { payment, response } = await billing.initiateB2B({
          reference,
          receiverShortCode: receiver,
          amount: AMOUNT,
          accountReference: reference.slice(0, 20),
          remarks: 'Smoke test B2B',
        })
        return {
          detail: `queued, ConversationID ${payment.providerRef}`,
          evidence: response,
        }
      })
    }
  }

  summarise()

  const failed = results.filter((r) => r.status === 'FAIL')
  if (failed.length > 0) process.exit(1)
}

/** Daraja's own description of what it did, when it gives one. */
function describe(body: unknown): string {
  const b = body as Record<string, unknown> | null
  const desc = b?.['ResponseDescription'] ?? b?.['ResultDesc'] ?? b?.['errorMessage']
  const code = b?.['ResponseCode'] ?? b?.['ResultCode'] ?? b?.['errorCode']
  if (desc || code) return `${code !== undefined ? `[${String(code)}] ` : ''}${String(desc ?? '')}`.trim()
  return JSON.stringify(body).slice(0, 120)
}

function summarise(): void {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skipped = results.filter((r) => r.status === 'SKIP').length

  console.log('\n' + '─'.repeat(64))
  console.log(`${pass} passed · ${fail} failed · ${skipped} skipped`)

  if (fail > 0) {
    console.log('\nFailures — these are real findings about the shipped code:')
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  ✗ ${r.name}: ${r.detail}`)
    }
  }

  console.log(`\nRaw Daraja responses written to scripts/sandbox/captured/.`)
  console.log('Callbacks, if any, land in the sink — check its own output.')
  console.log('─'.repeat(64) + '\n')
}

main().catch((error) => {
  console.error('\nSmoke run aborted:', error instanceof Error ? error.message : error)
  process.exit(1)
})
