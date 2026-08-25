/**
 * Database handle for the billing rails.
 *
 * Deliberately thin: `db()` returns a memoised Drizzle instance over a `pg`
 * Pool. If you are dropping this into an app that already has a Drizzle
 * client (SafariCharge uses Neon's HTTP driver), delete this file and point
 * the imports at the app's own `db()` — every module here only needs
 * `select` / `insert` / `update` / `transaction`.
 *
 * The connection string must belong to a role that BYPASSES RLS: the webhook
 * handlers write payment rows on behalf of Safaricom and Stripe, where there
 * is no authenticated user for the policies in db/schema.ts to resolve.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let cached: ReturnType<typeof create> | undefined;

function create() {
  const connectionString = process.env["BILLING_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("BILLING_DATABASE_URL (or DATABASE_URL) is not set");
  }
  return drizzle(new Pool({ connectionString }), { schema });
}

export function db() {
  cached ??= create();
  return cached;
}

export type Database = ReturnType<typeof db>;
export { schema };
