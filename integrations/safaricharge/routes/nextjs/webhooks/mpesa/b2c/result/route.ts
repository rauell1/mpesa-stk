/**
 * POST /api/webhooks/mpesa/b2c/result
 *
 * Outcome of a payout. Daraja acknowledges the initiation request
 * immediately and reports the real result here, keyed by ConversationID.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../db/client.js";
import { mpesaB2cRequests } from "../../../../../../db/schema.js";
import type { B2CResultPayload } from "../../../../../../src/mpesa/b2c.js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as B2CResultPayload;
    const result = payload?.Result;

    if (!result?.ConversationID) {
      console.warn("[mpesa] B2C result with no ConversationID");
      return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
    }

    const succeeded = result.ResultCode === 0;

    // Only settle a pending payout: a duplicate result must not flip a
    // completed payout back to failed, and the timeout handler may have
    // already written a terminal status.
    await db()
      .update(mpesaB2cRequests)
      .set({
        status: succeeded ? "completed" : "failed",
        errorCode: succeeded ? null : String(result.ResultCode),
        errorMessage: succeeded ? null : result.ResultDesc,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mpesaB2cRequests.conversationId, result.ConversationID),
          eq(mpesaB2cRequests.status, "pending"),
        ),
      );

    return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
  } catch (error) {
    console.error("[mpesa] B2C result failed", error);
    return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
  }
}
