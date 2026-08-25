/**
 * POST /api/webhooks/stripe
 *
 * The Stripe half of the same contract the M-PESA callback implements:
 * verify, settle with a compare-and-swap, grant the tier exactly once.
 *
 * Two things differ from M-PESA and both matter:
 *  - Stripe signs its webhooks, and the signature is computed over the RAW
 *    body — read `req.text()`, never `req.json()`, or verification fails on
 *    key ordering alone. An unverified endpoint lets anyone who knows the URL
 *    POST a fake `checkout.session.completed` and grant themselves premium.
 *  - Stripe retries on non-2xx with backoff, so a genuine server error SHOULD
 *    return 500 and be retried. Only a bad signature is a permanent 400.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../../../../db/client.js";
import { stripeTransactions } from "../../../../db/schema.js";
import { grantPlanTier } from "../../../../src/billing/tiers.js";
import { stripe, webhookSecret } from "../../../../src/stripe/client.js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await req.text();
    event = stripe().webhooks.constructEvent(rawBody, signature, webhookSecret());
  } catch (error) {
    // Bad signature or malformed body — never retryable, so 400 rather than
    // 500 stops Stripe re-sending it for three days.
    console.error("[stripe] webhook signature verification failed", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        // `payment_status` guards the async methods (bank debits) where the
        // session completes before the money settles.
        if (session.payment_status === "unpaid") break;
        await settleSession(session, "completed");
        break;
      }

      case "checkout.session.async_payment_succeeded": {
        await settleSession(event.data.object, "completed");
        break;
      }

      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        await settleSession(event.data.object, "failed");
        break;
      }

      default:
        // Everything else is enabled on the endpoint but not acted on.
        break;
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    // Let Stripe retry: unlike Safaricom it redelivers with backoff, so a
    // transient database failure recovers on its own.
    console.error("[stripe] webhook processing failed", event.type, error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

async function settleSession(
  session: Stripe.Checkout.Session,
  status: "completed" | "failed",
): Promise<void> {
  const organizationId = session.client_reference_id ?? session.metadata?.["organizationId"];
  if (!organizationId) {
    console.warn("[stripe] session with no organization reference", session.id);
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  await db().transaction(async (tx) => {
    const [settled] = await tx
      .update(stripeTransactions)
      .set({ status, stripePaymentIntentId: paymentIntentId, updatedAt: new Date() })
      .where(
        and(
          eq(stripeTransactions.checkoutSessionId, session.id),
          eq(stripeTransactions.status, "pending"),
        ),
      )
      .returning({ organizationId: stripeTransactions.organizationId });

    // Already settled — Stripe redelivered an event we have handled.
    if (!settled) return;
    if (status !== "completed") return;

    // Trust the row's organization, not the event's: the session id is what
    // we verified, and the row is what we wrote when we created it.
    await grantPlanTier(tx, settled.organizationId);
  });
}
