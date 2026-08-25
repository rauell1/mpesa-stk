/**
 * POST /api/webhooks/mpesa/c2b/validation
 *
 * Safaricom calls this BEFORE moving the customer's money. The account number
 * the customer typed is the organization id; if it is not a live organization
 * we reject here, because an accepted payment we cannot attribute has to be
 * refunded by hand.
 *
 * Rejections are 200 responses with a C2B error code — a non-200 is read as
 * "validator down", which the shortcode's ResponseType setting resolves, not
 * this handler.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../../db/client.js";
import { organizations } from "../../../../../../db/schema.js";
import type { C2BCallbackPayload } from "../../../../../../src/mpesa/c2b.js";

export const runtime = "nodejs";

const uuidSchema = z.string().uuid();

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as C2BCallbackPayload;
    const billRefNumber = payload?.BillRefNumber?.trim();

    if (!billRefNumber || !uuidSchema.safeParse(billRefNumber).success) {
      return NextResponse.json(
        {
          ResultCode: "C2B00012",
          ResultDesc: "Invalid Account Number. Enter your Organization ID.",
        },
        { status: 200 },
      );
    }

    const org = await db().query.organizations.findFirst({
      where: and(eq(organizations.id, billRefNumber), isNull(organizations.deletedAt)),
      columns: { id: true },
    });

    if (!org) {
      return NextResponse.json(
        { ResultCode: "C2B00012", ResultDesc: "Organization not found." },
        { status: 200 },
      );
    }

    return NextResponse.json({ ResultCode: "0", ResultDesc: "Accepted" }, { status: 200 });
  } catch (error) {
    console.error("[mpesa] C2B validation failed", error);
    // Reject rather than accept: we could not attribute this payment, and an
    // unattributable payment costs more to unwind than a declined one.
    return NextResponse.json(
      { ResultCode: "C2B00016", ResultDesc: "Unable to validate. Please try again." },
      { status: 200 },
    );
  }
}
