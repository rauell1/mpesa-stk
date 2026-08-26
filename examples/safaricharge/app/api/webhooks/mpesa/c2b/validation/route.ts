import { createWebhookRoutes } from 'mpesa-billing/next'
import { billing } from '../../../../../../lib/billing.js'

export const runtime = 'nodejs'
export const POST = createWebhookRoutes(billing).c2bValidation
