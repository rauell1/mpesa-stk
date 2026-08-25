/**
 * POST /api/billing/stripe/checkout
 *
 * Creates a Stripe Checkout session and returns the redirect URL. Mirrors the
 * M-PESA initiate route: a pending row now, the tier grant only on webhook.
 *
 * Body: { organizationId: uuid, amount: number (minor units), currency?: string }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createCheckoutSession } from "../../../../../src/stripe/checkout.js";

export const runtime = "nodejs";

const bodySchema = z.object({
  organizationId: z.string().uuid(),
  amount: z.number().int().positive(),
  currency: z.string().length(3).optional(),
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

  const { organizationId, amount, currency } = parsed.data;

  // AUTHORIZATION: same as the M-PESA initiate route — confirm the caller is
  // a member of organizationId before opening a session against it.

  try {
    const session = await createCheckoutSession({
      organizationId,
      amount,
      ...(currency ? { currency } : {}),
    });

    return NextResponse.json({ status: "success", ...session }, { status: 200 });
  } catch (error) {
    console.error("[stripe] checkout session failed", error);
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 502 });
  }
}
