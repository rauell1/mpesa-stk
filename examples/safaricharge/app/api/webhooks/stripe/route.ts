/**
 * POST /api/webhooks/stripe
 *
 * The binding reads the raw body for signature verification — do not add a
 * body parser in front of this route.
 */

import { createWebhookRoutes } from 'mpesa-billing/next'
import { billing } from '../../../../lib/billing.js'

export const runtime = 'nodejs'
export const POST = createWebhookRoutes(billing).stripeWebhook
