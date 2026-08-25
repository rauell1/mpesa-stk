/**
 * POST /api/webhooks/mpesa — STK Push callback.
 *
 * Daraja re-fires this callback under load and gives no idempotency key, so
 * settlement is a compare-and-swap: the UPDATE carries `status = 'pending'`
 * in its WHERE clause and returns the row it changed. Exactly one of N racing
 * callbacks gets a row back, and only that one grants the plan tier — a
 * read-then-check would hand the tier out twice.
 *
 * Always answer 200: a non-200 makes Safaricom retry a callback we have
 * already processed, and the retry carries no new information.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db/client.js";
import { mpesaTransactions } from "../../../../db/schema.js";
import { grantPlanTier } from "../../../../src/billing/tiers.js";
import type { MpesaCallbackBody } from "../../../../src/mpesa/types.js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as MpesaCallbackBody;
    const callback = payload?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      console.warn("[mpesa] callback with no stkCallback body");
      return NextResponse.json({ ResultCode: 0, ResultDesc: "Ignored" }, { status: 200 });
    }

    const { CheckoutRequestID: checkoutRequestId, ResultCode: resultCode } = callback;

    if (resultCode !== 0) {
      // Cancelled, wrong PIN, insufficient funds, timeout — all terminal.
      await db()
        .update(mpesaTransactions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(
          and(
            eq(mpesaTransactions.checkoutRequestId, checkoutRequestId),
            eq(mpesaTransactions.status, "pending"),
          ),
        );

      return NextResponse.json({ ResultCode: 0, ResultDesc: "Success" }, { status: 200 });
    }

    const metadata = "CallbackMetadata" in callback ? callback.CallbackMetadata?.Item : undefined;
    const receipt = metadata?.find((item) => item.Name === "MpesaReceiptNumber")?.Value;

    await db().transaction(async (tx) => {
      const [settled] = await tx
        .update(mpesaTransactions)
        .set({
          status: "completed",
          receiptNumber: receipt === undefined ? null : String(receipt),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mpesaTransactions.checkoutRequestId, checkoutRequestId),
            eq(mpesaTransactions.status, "pending"),
          ),
        )
        .returning({ organizationId: mpesaTransactions.organizationId });

      // No row: either a duplicate callback, or a CheckoutRequestID we never
      // issued. Both mean "do not grant anything".
      if (!settled) return;

      await grantPlanTier(tx, settled.organizationId);
    });

    return NextResponse.json({ ResultCode: 0, ResultDesc: "Success" }, { status: 200 });
  } catch (error) {
    console.error("[mpesa] STK callback failed", error);
    // Acknowledged deliberately: retries would replay the same failure.
    // The reconciliation pass is what recovers a payment lost here.
    return NextResponse.json(
      { ResultCode: 0, ResultDesc: "Acknowledged" },
      { status: 200 },
    );
  }
}
