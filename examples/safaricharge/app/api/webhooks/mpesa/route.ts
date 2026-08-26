/**
 * POST /api/webhooks/mpesa — STK Push callback.
 *
 * Three lines, because the interesting parts — dedup, the plan grant, the
 * always-200 convention — live in the package and in lib/billing.ts.
 *
 * `runtime = 'nodejs'` is required: the pg pool and node:crypto are not
 * available on the edge runtime.
 */

import { createWebhookRoutes } from 'mpesa-billing/next'
import { billing } from '../../../../lib/billing.js'

export const runtime = 'nodejs'
export const POST = createWebhookRoutes(billing).stkCallback
