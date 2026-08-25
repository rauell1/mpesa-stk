/**
 * Plan tier grants — the one thing every payment rail ends in.
 *
 * Both M-PESA and Stripe settle to the same place: a paid organization moves
 * to `premium` until `plan_expires_at`. Keeping that in one function is what
 * stops the two rails from drifting into subtly different entitlements.
 */

import { eq, sql } from "drizzle-orm";
import { organizations } from "../../db/schema.js";
import type { Database } from "../../db/client.js";

/** How long one payment buys. */
export const PREMIUM_PERIOD_DAYS = 30;

export type PlanTier = "free" | "premium";

/**
 * Accepts either the db handle or a transaction — structurally both are "a
 * thing with .update()", which keeps this usable from inside `db().transaction`
 * without importing Drizzle's transaction generics.
 */
type Executor = Pick<Database, "update">;

/**
 * Extend an organization's plan by `days`.
 *
 * Extension is computed in SQL from the row's current expiry, not from a
 * timestamp read earlier in the request: paying twice in a month should add
 * two months, and two callbacks landing together must not both compute
 * `now + 30` off the same stale read. Expired plans restart from now.
 */
export async function grantPlanTier(
  executor: Executor,
  organizationId: string,
  options: { tier?: PlanTier; days?: number } = {},
): Promise<void> {
  const tier = options.tier ?? "premium";
  const days = options.days ?? PREMIUM_PERIOD_DAYS;

  await executor
    .update(organizations)
    .set({
      planTier: tier,
      planExpiresAt: sql`GREATEST(COALESCE(${organizations.planExpiresAt}, now()), now()) + make_interval(days => ${days})`,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}
