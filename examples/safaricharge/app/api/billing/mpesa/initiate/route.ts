/**
 * POST /api/billing/mpesa/initiate
 *
 * Sends the STK prompt and records a PENDING payment. No plan is granted here
 * — only a settled callback grants anything.
 *
 * The package ships no initiation route on purpose: this is where
 * authorization lives, and it cannot be written generically. `organizationId`
 * arrives from the client, so it is checked against the caller's session
 * before anything is spent against the shortcode.
 */

import { billing } from '../../../../../lib/billing.js'
import { requireOrgMember } from '../../../../../lib/authz.js'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  let body: { organizationId?: string; phoneNumber?: string; amount?: number }

  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { organizationId, phoneNumber, amount } = body

  if (!organizationId || !phoneNumber || typeof amount !== 'number') {
    return Response.json(
      { error: 'organizationId, phoneNumber and amount are required' },
      { status: 400 },
    )
  }

  if (!(await requireOrgMember(organizationId))) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const { payment, customerMessage } = await billing.initiateStkPush({
      reference: organizationId,
      phoneNumber,
      amount,
      // Daraja truncates these at 12 and 13 characters. The organization is
      // carried on the payment row, not through Safaricom.
      accountReference: `SC-${organizationId.slice(0, 8)}`,
      description: 'SC premium',
    })

    return Response.json({
      paymentId: payment.id,
      checkoutRequestId: payment.providerRef,
      message: customerMessage,
    })
  } catch (error) {
    console.error('[billing] STK initiation failed', error)
    return Response.json({ error: 'Failed to initiate M-PESA payment' }, { status: 502 })
  }
}
