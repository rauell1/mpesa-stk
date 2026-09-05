/**
 * Callback sink — the inbound half of the sandbox smoke test.
 *
 * The outbound half proves Daraja accepts our requests. This proves we
 * understand its answers, which is the part hand-written fixtures cannot
 * establish: every callback test in this repository parses a payload *I*
 * wrote, shaped by what the docs claim. A parser can be confidently wrong
 * about a field nobody has ever seen.
 *
 * So this does not merely log. It feeds each delivery to the library's real
 * handler and reports what happened — parsed or not, settled or not — then
 * writes the raw body to ./captured/ so a genuine payload can replace a
 * guessed one in the test suite.
 *
 * With DATABASE_URL set it uses PostgresStore, which makes the run a true
 * end-to-end test: the migration executes, the compare-and-swap runs in real
 * SQL, and a redelivered callback is really deduplicated. Without it,
 * MemoryStore verifies parsing only — and since the smoke script is a separate
 * process, nothing it initiated will be in this store, so every delivery will
 * report "unknown payment". That is expected, and still tells you the parser
 * worked.
 *
 * Run:
 *   npm run sandbox:sink
 *   cloudflared tunnel --url http://localhost:3010     # or ngrok http 3010
 *   # then set MPESA_CALLBACK_BASE_URL to the public https:// origin
 */

import { serve } from '@hono/node-server'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Billing } from '../../packages/mpesa-billing/src/billing.js'
import { MemoryStore } from '../../packages/mpesa-billing/src/adapters/memory.js'
import {
  parseC2B,
  parseJson,
  parsePayoutResult,
  parsePayoutTimeout,
  parseStkCallback,
} from '../../packages/mpesa-billing/src/callbacks.js'
import { toMajorString } from '../../packages/mpesa-billing/src/money.js'
import { DEFAULT_CALLBACK_PATHS } from '../../packages/mpesa-billing/src/types.js'
import type { BillingStore } from '../../packages/mpesa-billing/src/adapters/types.js'
import type { WebhookResult } from '../../packages/mpesa-billing/src/types.js'

/**
 * Where captured payloads go. Resolved from the working directory rather than
 * `import.meta.dirname`, which is unavailable in this package's CommonJS module
 * mode — and npm always runs a script from the package root, which is also
 * where `npx tsx scripts/...` is invoked from.
 */
const CAPTURED = join(process.cwd(), 'scripts', 'sandbox', 'captured')
const PORT = Number(process.env['SINK_PORT'] ?? 3010)

/** Paths in the log are relative to the repo, so they can be copy-pasted. */
function relative(file: string): string {
  return file.startsWith(process.cwd()) ? file.slice(process.cwd().length + 1) : file
}

function capture(label: string, raw: string): string {
  mkdirSync(CAPTURED, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(CAPTURED, `${stamp}__callback-${label}.json`)
  // Written verbatim — reformatting it would defeat the point of capturing it.
  writeFileSync(file, raw.endsWith('\n') ? raw : raw + '\n', 'utf8')
  return file
}

async function buildStore(): Promise<{ store: BillingStore; kind: string }> {
  const url = process.env['DATABASE_URL']
  if (!url) return { store: new MemoryStore(), kind: 'MemoryStore (parse-only)' }

  // Imported lazily so the sink runs without pg installed or a database up.
  const { Pool } = await import('pg')
  const { PostgresStore } = await import('../../packages/mpesa-billing/src/adapters/postgres.js')
  const store = new PostgresStore(new Pool({ connectionString: url }))
  // This is the first time the migration has ever run anywhere. If the DDL is
  // wrong, it fails here, loudly, which is the point.
  await store.migrate()
  return { store, kind: 'PostgresStore (end-to-end)' }
}

async function main(): Promise<void> {
  const { store, kind } = await buildStore()

  const billing = new Billing({
    store,
    // Deliberately not setting trustedMpesaIps: a tunnel rewrites the source
    // address, so the check would reject every genuine delivery and teach us
    // nothing. Enable it in your app, behind a proxy you control.
    validateC2BReference: async (reference) => {
      console.log(`   → validateC2BReference('${reference}') → accepting (sink accepts all)`)
      return true
    },
    logger: {
      info: (m, meta) => console.log(`   [info] ${m}`, meta ?? ''),
      warn: (m, meta) => console.log(`   [warn] ${m}`, meta ?? ''),
      error: (m, meta) => console.log(`   [error] ${m}`, meta ?? ''),
    },
  })

  billing.onPaymentSettled((p) => {
    console.log(
      `   ★ SETTLED  ${p.rail} ${p.reference} ${p.status} ` +
        `${p.settledAmount?.currency ?? p.amount.currency} ` +
        `${((p.settledAmount ?? p.amount).minor / 100).toFixed(2)} ` +
        `receipt=${p.receipt ?? '(none)'}`,
    )
  })

  /**
   * Did the parser understand this payload, and what did it pull out?
   *
   * Reported separately from settlement on purpose. "Nothing settled" has two
   * completely different causes — the parser did not understand the payload, or
   * it understood it perfectly and we hold no matching payment — and a sink
   * that blurs them cannot answer the question it exists to answer. Since the
   * smoke script runs in a different process, "no matching payment" is the
   * normal case here, which makes the parse line the real result.
   */
  function describeParse(path: string, raw: string): string {
    const body = parseJson(raw)
    if (body === null) return 'NO — body is not JSON'

    switch (path) {
      case DEFAULT_CALLBACK_PATHS.stkCallback: {
        const p = parseStkCallback(body)
        if (!p) return 'NO — parseStkCallback returned null'
        return (
          `yes — code ${p.resultCode}, receipt ${p.receipt ?? '(none)'}, ` +
          `amount ${p.amount ? toMajorString(p.amount) : '(none)'}, ` +
          `phone ${p.phoneNumber ?? '(masked/absent)'}`
        )
      }
      case DEFAULT_CALLBACK_PATHS.c2bValidation:
      case DEFAULT_CALLBACK_PATHS.c2bConfirmation: {
        const p = parseC2B(body)
        if (!p) return 'NO — parseC2B returned null'
        return `yes — ref '${p.reference}', KES ${toMajorString(p.amount)}, TransID ${p.transId}`
      }
      case DEFAULT_CALLBACK_PATHS.b2cResult:
      case DEFAULT_CALLBACK_PATHS.b2bResult: {
        const p = parsePayoutResult(body)
        if (!p) return 'NO — parsePayoutResult returned null'
        return (
          `yes — code ${p.resultCode}, receipt ${p.receipt ?? '(none)'}, ` +
          `amount ${p.amount ? toMajorString(p.amount) : '(none)'}, ` +
          `params [${Object.keys(p.parameters).join(', ') || 'none'}]`
        )
      }
      case DEFAULT_CALLBACK_PATHS.b2cTimeout:
      case DEFAULT_CALLBACK_PATHS.b2bTimeout: {
        const p = parsePayoutTimeout(body)
        return p ? `yes — ConversationID ${p.conversationId}` : 'NO — parsePayoutTimeout returned null'
      }
      default:
        return 'n/a'
    }
  }

  function report(path: string, raw: string, result: WebhookResult, file: string): void {
    const settled = result.settled
    console.log(`   parsed:  ${describeParse(path, raw)}`)
    console.log(
      `   settled: ${
        settled
          ? `${settled.status} (${settled.id})`
          : 'nothing — no matching payment here, or already terminal'
      }`,
    )
    console.log(`   replied: ${result.reply.status} ${JSON.stringify(result.reply.body)}`)
    console.log(`   saved:   ${relative(file)}`)
    console.log()
  }

  const handlers: Record<string, (body: string) => Promise<WebhookResult>> = {
    [DEFAULT_CALLBACK_PATHS.stkCallback]: (b) => billing.handleStkCallback(b),
    [DEFAULT_CALLBACK_PATHS.c2bValidation]: (b) => billing.handleC2BValidation(b),
    [DEFAULT_CALLBACK_PATHS.c2bConfirmation]: (b) => billing.handleC2BConfirmation(b),
    [DEFAULT_CALLBACK_PATHS.b2cResult]: (b) => billing.handleB2CResult(b),
    [DEFAULT_CALLBACK_PATHS.b2cTimeout]: (b) => billing.handleB2CTimeout(b),
    [DEFAULT_CALLBACK_PATHS.b2bResult]: (b) => billing.handleB2BResult(b),
    [DEFAULT_CALLBACK_PATHS.b2bTimeout]: (b) => billing.handleB2BTimeout(b),
  }

  const server = serve(
    {
      port: PORT,
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname

        if (request.method === 'GET' && path === '/') {
          return new Response(
            `mpesa sandbox callback sink\n\n${Object.keys(handlers).map((p) => `  POST ${p}`).join('\n')}\n`,
            { headers: { 'content-type': 'text/plain' } },
          )
        }

        const handler = handlers[path]
        const raw = await request.text()

        if (!handler) {
          // Worth seeing: it means Safaricom is calling a path we did not
          // expect, which is itself a finding about the callback URLs we sent.
          console.log(`\n▼ ${request.method} ${path}  — NO HANDLER FOR THIS PATH`)
          console.log(`   saved: ${relative(capture('unrouted', raw))}`)
          console.log()
          return Response.json({ ResultCode: '0', ResultDesc: 'Acknowledged' })
        }

        const label = path.split('/').filter(Boolean).slice(2).join('-') || 'stk'
        console.log(`\n▼ ${path}`)
        console.log(`   body:    ${raw.length > 300 ? raw.slice(0, 300) + '…' : raw}`)

        const file = capture(label, raw)
        const result = await handler(raw)
        report(path, raw, result, file)

        return new Response(JSON.stringify(result.reply.body), {
          status: result.reply.status,
          headers: { 'content-type': 'application/json' },
        })
      },
    },
    (info) => {
      console.log('\nmpesa sandbox callback sink')
      console.log('─'.repeat(64))
      console.log(`listening   http://localhost:${info.port}`)
      console.log(`store       ${kind}`)
      console.log(`captures    scripts/sandbox/captured/`)
      console.log('─'.repeat(64))
      console.log('\nExpose this publicly, then point MPESA_CALLBACK_BASE_URL at it:')
      console.log(`  cloudflared tunnel --url http://localhost:${info.port}`)
      console.log(`  ngrok http ${info.port}`)
      console.log('\nWaiting for callbacks. Ctrl-C to stop.\n')
    },
  )

  const shutdown = (): void => {
    console.log('\nStopping sink.')
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('\nSink failed to start:', error instanceof Error ? error.message : error)
  process.exit(1)
})
