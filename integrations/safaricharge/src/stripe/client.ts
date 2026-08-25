/**
 * Stripe SDK handle.
 *
 * `stripe` is a peer dependency of this integration — install it in the host
 * app (`npm install stripe`). The API version is deliberately not pinned
 * here: the SDK pins the version it was built against, and overriding it with
 * a hand-written literal is how a routine `npm update` starts returning
 * fields the handlers do not expect.
 */

import Stripe from "stripe";

let cached: Stripe | undefined;

export function stripe(): Stripe {
  if (!cached) {
    const key = process.env["STRIPE_SECRET_KEY"];
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    cached = new Stripe(key);
  }
  return cached;
}

export function webhookSecret(): string {
  const secret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return secret;
}
