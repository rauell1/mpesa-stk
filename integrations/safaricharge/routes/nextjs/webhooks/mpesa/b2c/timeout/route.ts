/**
 * POST /api/webhooks/mpesa/b2c/timeout
 *
 * Safaricom calls this when a payout request expires in its queue. The
 * payload shape is inconsistent — sometimes flat, sometimes wrapped in
 * `Result` — so read the ConversationID out of either.
 *
 * "Timed out in the queue" is not the same as "the money did not move";
 * the row is marked failed, and reconciliation against the transaction
 * status API is what confirms it.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../db/client.js";
import { mpesaB2cRequests } from "../../../../../../db/schema.js";
import type { B2CTimeoutPayload } from "../../../../../../src/mpesa/types.js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as B2CTimeoutPayload;
    const conversationId = payload?.ConversationID ?? payload?.Result?.ConversationID;

    if (conversationId) {
      await db()
        .update(mpesaB2cRequests)
        .set({
          status: "failed",
          errorMessage: "Request timed out in the Daraja queue",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mpesaB2cRequests.conversationId, conversationId),
            eq(mpesaB2cRequests.status, "pending"),
          ),
        );
    } else {
      console.warn("[mpesa] B2C timeout with no ConversationID", payload);
    }

    return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
  } catch (error) {
    console.error("[mpesa] B2C timeout failed", error);
    return NextResponse.json({ ResultCode: "0", ResultDesc: "Acknowledged" }, { status: 200 });
  }
}
