/**
 * POST /api/billing/mpesa/initiate
 *
 * Sends the STK Push prompt and records a pending transaction. The plan tier
 * is NOT granted here — only the callback settles a payment.
 *
 * Body: { organizationId: uuid, phoneNumber: string, amount: number }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "../../../../../db/client.js";
import { mpesaTransactions } from "../../../../../db/schema.js";
import { initiateStkPush } from "../../../../../src/mpesa/stk.js";

export const runtime = "nodejs";

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  phoneNumber: z.string().min(9),
  amount: z.number().int().positive(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = bodySchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { organizationId, phoneNumber, amount } = parsed.data;

  // AUTHORIZATION: organizationId arrives from the client, so confirm the
  // caller is a member of it before spending money against their shortcode.
  // In SafariCharge this is `await requireOrgMember(organizationId)` from
  // @/lib/authz/membership — wire the host app's equivalent here.

  try {
    const result = await initiateStkPush({
      // Daraja caps these at 12 and 13 characters. The organization is
      // recorded on the row below, not carried through Safaricom.
      phoneNumber,
      amount,
      accountReference: `SC-${organizationId.slice(0, 8)}`,
      description: "SC premium",
    });

    await db().insert(mpesaTransactions).values({
      organizationId,
      checkoutRequestId: result.CheckoutRequestID,
      amount: amount.toString(),
      phoneNumber,
      status: "pending",
    });

    return NextResponse.json(
      {
        status: "success",
        checkoutRequestId: result.CheckoutRequestID,
        customerMessage: result.CustomerMessage,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[mpesa] initiate failed", error);
    return NextResponse.json({ error: "Failed to initiate M-PESA payment" }, { status: 502 });
  }
}
