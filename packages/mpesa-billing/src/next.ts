/**
 * Next.js App Router bindings.
 *
 * Nothing here imports `next` — App Router route handlers are plain
 * `(Request) => Response` functions, so these work unchanged in any
 * Web-standard runtime (Next, Hono, Bun, workers with a Node-compatible
 * crypto). The bindings exist because three details are easy to get wrong:
 * reading the Stripe body as raw text, returning the provider's expected
 * status code rather than your framework's default, and finding the caller's
 * real IP behind a proxy.
 */

import type { Billing } from './billing.js'
import type { WebhookContext, WebhookReply } from './types.js'

function toResponse(reply: WebhookReply): Response {
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  })
}

export type RouteHandler = (request: Request) => Promise<Response>

export interface WebhookRoutes {
  /** POST /api/webhooks/mpesa */
  stkCallback: RouteHandler
  /** POST /api/webhooks/mpesa/c2b/validation */
  c2bValidation: RouteHandler
  /** POST /api/webhooks/mpesa/c2b/confirmation */
  c2bConfirmation: RouteHandler
  /** POST /api/webhooks/mpesa/b2c/result */
  b2cResult: RouteHandler
  /** POST /api/webhooks/mpesa/b2c/timeout */
  b2cTimeout: RouteHandler
  /** POST /api/webhooks/mpesa/b2b/result */
  b2bResult: RouteHandler
  /** POST /api/webhooks/mpesa/b2b/timeout */
  b2bTimeout: RouteHandler
  /** POST /api/webhooks/stripe */
  stripeWebhook: RouteHandler
}

export interface WebhookRouteOptions {
  /**
   * Header carrying the caller's IP, when you have set `trustedMpesaIps` on
   * the Billing instance. Default `x-forwarded-for`, whose first entry is the
   * original client.
   *
   * Only trust this if a proxy you control writes it — a header is client
   * input everywhere else, and an attacker who can set it can claim to be
   * Safaricom. On Vercel prefer `x-vercel-forwarded-for`; on Cloudflare,
   * `cf-connecting-ip`.
   */
  sourceIpHeader?: string
}

function contextFrom(request: Request, options: WebhookRouteOptions): WebhookContext {
  const header = options.sourceIpHeader ?? 'x-forwarded-for'
  const value = request.headers.get(header)
  if (!value) return {}
  // x-forwarded-for is "client, proxy1, proxy2" — the client is the first.
  const first = value.split(',')[0]?.trim()
  return first ? { sourceIp: first } : {}
}

/**
 * Build the webhook route handlers for one Billing instance.
 *
 * Export them from route files whose paths match the callback paths in your
 * Daraja config (see DEFAULT_CALLBACK_PATHS), and set
 * `export const runtime = 'nodejs'` alongside — the signature verification and
 * the `pg` pool both need Node, not the edge runtime.
 */
export function createWebhookRoutes(
  billing: Billing,
  options: WebhookRouteOptions = {},
): WebhookRoutes {
  const mpesa =
    (handle: (body: string, context: WebhookContext) => Promise<{ reply: WebhookReply }>): RouteHandler =>
    async (request) =>
      toResponse((await handle(await request.text(), contextFrom(request, options))).reply)

  return {
    stkCallback: mpesa((body, ctx) => billing.handleStkCallback(body, ctx)),
    c2bValidation: mpesa((body, ctx) => billing.handleC2BValidation(body, ctx)),
    c2bConfirmation: mpesa((body, ctx) => billing.handleC2BConfirmation(body, ctx)),
    b2cResult: mpesa((body, ctx) => billing.handleB2CResult(body, ctx)),
    b2cTimeout: mpesa((body, ctx) => billing.handleB2CTimeout(body, ctx)),
    b2bResult: mpesa((body, ctx) => billing.handleB2BResult(body, ctx)),
    b2bTimeout: mpesa((body, ctx) => billing.handleB2BTimeout(body, ctx)),

    stripeWebhook: async (request) => {
      // Raw text, not request.json(): Stripe signs the exact bytes, and
      // re-serialising parsed JSON changes key order enough to fail the check.
      const rawBody = await request.text()
      const result = await billing.handleStripeWebhook(rawBody, request.headers.get('stripe-signature'))
      return toResponse(result.reply)
    },
  }
}
