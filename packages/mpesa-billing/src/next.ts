/**
 * Next.js App Router bindings.
 *
 * Nothing here imports `next` — App Router route handlers are plain
 * `(Request) => Response` functions, so these work unchanged in any
 * Web-standard runtime (Next, Hono, Bun, workers with a Node-compatible
 * crypto). The bindings exist because two details are easy to get wrong:
 * reading the Stripe body as raw text, and returning the provider's expected
 * status code rather than your framework's default.
 */

import type { Billing } from './billing.js'
import type { WebhookReply } from './types.js'

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
  /** POST /api/webhooks/stripe */
  stripeWebhook: RouteHandler
}

/**
 * Build the six webhook route handlers for one Billing instance.
 *
 * Export them from route files whose paths match the callback paths in your
 * Daraja config (see DEFAULT_CALLBACK_PATHS), and set
 * `export const runtime = 'nodejs'` alongside — the signature verification and
 * the `pg` pool both need Node, not the edge runtime.
 */
export function createWebhookRoutes(billing: Billing): WebhookRoutes {
  return {
    stkCallback: async (request) => toResponse((await billing.handleStkCallback(await request.text())).reply),

    c2bValidation: async (request) =>
      toResponse((await billing.handleC2BValidation(await request.text())).reply),

    c2bConfirmation: async (request) =>
      toResponse((await billing.handleC2BConfirmation(await request.text())).reply),

    b2cResult: async (request) => toResponse((await billing.handleB2CResult(await request.text())).reply),

    b2cTimeout: async (request) => toResponse((await billing.handleB2CTimeout(await request.text())).reply),

    stripeWebhook: async (request) => {
      // Raw text, not request.json(): Stripe signs the exact bytes, and
      // re-serialising parsed JSON changes key order enough to fail the check.
      const rawBody = await request.text()
      const result = await billing.handleStripeWebhook(rawBody, request.headers.get('stripe-signature'))
      return toResponse(result.reply)
    },
  }
}
