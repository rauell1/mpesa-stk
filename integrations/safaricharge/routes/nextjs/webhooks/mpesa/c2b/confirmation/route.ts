/**
 * POST /api/webhooks/mpesa/c2b/confirmation
 *
 * The money has moved. Record it and extend the plan.
 *
 * Idempotency rides on the UNIQUE constraint on `trans_id` (Safaricom's
 * receipt): the INSERT is `ON CONFLICT DO NOTHING … RETURNING`, so a replayed
 * confirmation returns no row and skips the grant. Doing this with a SELECT
 * first would leave a window where two retries both see "not recorded yet".
 */

import { NextResponse } from "next/server";
import { db } from "../../../../../../db/client.js";
import { mpesaC2bTransactions } from "../../../../../../db/schema.js";
import { grantPlanTier } from "../../../../../../src/billing/tiers.js";
import type { C2BCallbackPayload } from "../../../../../../src/mpesa/c2b.js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as C2BCallbackPayload;
    const organizationId = payload?.BillRefNumber?.trim();

    if (!organizationId || !payload?.TransID) {
      console.warn("[mpesa] C2B confirmation missing BillRefNumber or TransID");
      return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
    }

    await db().transaction(async (tx) => {
      const [recorded] = await tx
        .insert(mpesaC2bTransactions)
        .values({
          organizationId,
          transId: payload.TransID,
          transAmount: payload.TransAmount,
          billRefNumber: organizationId,
          msisdn: payload.MSISDN,
          firstName: payload.FirstName ?? null,
          status: "completed",
        })
        .onConflictDoNothing({ target: mpesaC2bTransactions.transId })
        .returning({ organizationId: mpesaC2bTransactions.organizationId });

      // Already recorded — a Safaricom retry, not a second payment.
      if (!recorded) return;

      await grantPlanTier(tx, recorded.organizationId);
    });

    return NextResponse.json({ ResultCode: "0", ResultDesc: "Success" }, { status: 200 });
  } catch (error) {
    // Validation already accepted this payment, so the money is ours whether
    // or not we recorded it. Acknowledge and let reconciliation pick it up —
    // asking Safaricom to retry would not make the write succeed.
    console.error("[mpesa] C2B confirmation failed", error);
    return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
  }
}
