/**
 * Stripe Checkout — the card rail, for organizations paying from outside
 * Kenya where M-PESA is not an option.
 *
 * Same contract as the M-PESA side: create a provider-side handle, record a
 * pending row keyed by it, and let the webhook settle it. Nothing here grants
 * a plan tier — a created session is not a payment.
 */

import { db } from "../../db/client.js";
import { stripeTransactions } from "../../db/schema.js";
import { PREMIUM_PERIOD_DAYS } from "../billing/tiers.js";
import { stripe } from "./client.js";

export interface CheckoutParams {
  organizationId: string;
  /** Smallest currency unit — cents for USD, as Stripe expects. */
  amount: number;
  currency?: string;
  /** Where to send the customer back to; defaults to APP_URL/workspace. */
  successUrl?: string;
  cancelUrl?: string;
  /** Reuses an existing session for a retried request. */
  idempotencyKey?: string;
}

export interface CheckoutResult {
  sessionId: string;
  url: string;
}

export async function createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult> {
  const currency = params.currency ?? "usd";
  const amount = Math.trunc(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`amount must be a positive integer in the smallest currency unit, got ${params.amount}`);
  }

  const appUrl = (process.env["NEXT_PUBLIC_APP_URL"] ?? "").replace(/\/+$/, "");
  if (!appUrl && !(params.successUrl && params.cancelUrl)) {
    // Stripe rejects relative return URLs, and the failure surfaces as an
    // opaque parameter error rather than "your env var is empty".
    throw new Error("NEXT_PUBLIC_APP_URL is not set and no return URLs were provided");
  }

  const session = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: `Premium tier — ${PREMIUM_PERIOD_DAYS} days` },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      // Both are set: client_reference_id is what the webhook reads, metadata
      // is what a human reads in the Stripe dashboard during a dispute.
      client_reference_id: params.organizationId,
      metadata: { organizationId: params.organizationId },
      success_url: `${appUrl}/workspace?checkout=success`,
      cancel_url: `${appUrl}/workspace?checkout=cancelled`,
      ...(params.successUrl ? { success_url: params.successUrl } : {}),
      ...(params.cancelUrl ? { cancel_url: params.cancelUrl } : {}),
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {},
  );

  if (!session.url) {
    throw new Error(`Stripe returned a session without a redirect URL (${session.id})`);
  }

  // A retried request carrying the same idempotencyKey gets the same session
  // back from Stripe, so the row is already there — that is a re-issue, not a
  // second payment.
  await db()
    .insert(stripeTransactions)
    .values({
      organizationId: params.organizationId,
      checkoutSessionId: session.id,
      amount: amount.toString(),
      currency,
      status: "pending",
    })
    .onConflictDoNothing({ target: stripeTransactions.checkoutSessionId });

  return { sessionId: session.id, url: session.url };
}
