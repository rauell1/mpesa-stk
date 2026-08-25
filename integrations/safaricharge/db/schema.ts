/**
 * Billing schema — M-PESA (Daraja) and Stripe, scoped to an organization.
 *
 * Mirrors the SafariCharge tables so both codebases stay in sync; column
 * names and constraints match `drizzle/0013`–`0015` there. Every org-scoped
 * table carries `organization_id`, has RLS enabled, and exposes a read
 * policy that resolves membership through `organization_members` — the
 * webhook handlers write through a service role that bypasses RLS, so the
 * policies only ever gate reads from the app.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  index,
  check,
  pgRole,
  pgPolicy,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const authenticatedRole = pgRole("authenticated");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/** Membership of the calling user in the row's organization, or NULL. */
const memberOfOrg = (orgIdColumn: AnyPgColumn) =>
  sql`(select auth_user_id from "organization_members" where organization_id = ${orgIdColumn} and auth_user_id = auth.user_id()) is not null`;

// ---------------------------------------------------------------------------
// Tenancy — trimmed to the columns the billing rails touch. If the host app
// already owns these tables, delete them here and import its own definitions.
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** 'free' until a payment settles; see src/billing/tiers.ts */
    planTier: text("plan_tier").notNull().default("free"),
    planExpiresAt: timestamp("plan_expires_at", { withTimezone: true }),
    ...timestamps,
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("organizations_name_length", sql`length(${t.name}) BETWEEN 1 AND 200`),
    pgPolicy("organization_read_access", {
      as: "permissive",
      for: "select",
      to: authenticatedRole,
      using: memberOfOrg(t.id),
    }),
  ],
);

export const ORGANIZATION_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    authUserId: text("auth_user_id").notNull(),
    role: text("role").$type<OrganizationRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.authUserId] }),
    index("organization_members_auth_user_idx").on(t.authUserId),
    check(
      "organization_members_role_valid",
      sql`${t.role} IN ('owner','admin','member','viewer')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// M-PESA
// ---------------------------------------------------------------------------

/**
 * STK Push (Lipa na M-PESA Online). One row per push; `checkout_request_id`
 * is Daraja's handle for the prompt and the key the callback arrives under,
 * so it is UNIQUE — a re-fired callback updates the same row rather than
 * inserting a second one.
 */
export const mpesaTransactions = pgTable(
  "mpesa_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    checkoutRequestId: text("checkout_request_id").notNull().unique(),
    amount: text("amount").notNull(),
    phoneNumber: text("phone_number").notNull(),
    status: text("status").notNull().default("pending"),
    receiptNumber: text("receipt_number"),
    ...timestamps,
  },
  (t) => [
    index("mpesa_transactions_org_idx").on(t.organizationId),
    index("mpesa_transactions_status_idx").on(t.status),
    check(
      "mpesa_transactions_status_valid",
      sql`${t.status} IN ('pending', 'completed', 'failed')`,
    ),
    pgPolicy("mpesa_transactions_read_access", {
      as: "permissive",
      for: "select",
      to: authenticatedRole,
      using: memberOfOrg(t.organizationId),
    }),
  ],
);

/**
 * Daraja OAuth token cache. Tokens live 3599s and Safaricom rate-limits the
 * token endpoint, so every call re-uses the newest unexpired row instead of
 * minting a fresh token per request. Not org-scoped — the credentials belong
 * to the platform, not the tenant — and never exposed to the client, hence
 * no read policy.
 */
export const mpesaAuthTokens = pgTable(
  "mpesa_auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessToken: text("access_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    environment: text("environment").notNull().default("sandbox"),
    ...timestamps,
  },
  (t) => [index("mpesa_auth_tokens_env_expiry_idx").on(t.environment, t.expiresAt)],
);

/**
 * C2B — customer-initiated paybill payments. The customer types the
 * organization id as the account number, which is what `bill_ref_number`
 * carries; validation rejects anything that is not a known org before the
 * money moves. `trans_id` is Safaricom's receipt and is UNIQUE, which is what
 * makes the confirmation handler idempotent under Daraja's retries.
 */
export const mpesaC2bTransactions = pgTable(
  "mpesa_c2b_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    transId: text("trans_id").notNull().unique(),
    transAmount: text("trans_amount").notNull(),
    billRefNumber: text("bill_ref_number").notNull(),
    msisdn: text("msisdn").notNull(),
    firstName: text("first_name"),
    status: text("status").notNull().default("completed"),
    ...timestamps,
  },
  (t) => [
    index("mpesa_c2b_transactions_org_idx").on(t.organizationId),
    index("mpesa_c2b_transactions_trans_idx").on(t.transId),
    pgPolicy("mpesa_c2b_transactions_read_access", {
      as: "permissive",
      for: "select",
      to: authenticatedRole,
      using: memberOfOrg(t.organizationId),
    }),
  ],
);

/**
 * B2C — payouts from the shortcode to a customer (refunds, rebates).
 * Keyed by Daraja's `conversation_id`; the result and timeout callbacks both
 * settle the row. Not org-scoped: a payout is a platform-side action.
 */
export const mpesaB2cRequests = pgTable(
  "mpesa_b2c_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: text("conversation_id").unique(),
    originatorConversationId: text("originator_conversation_id").unique(),
    amount: text("amount").notNull(),
    phoneNumber: text("phone_number").notNull(),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    ...timestamps,
  },
  (t) => [
    index("mpesa_b2c_requests_status_idx").on(t.status),
    check(
      "mpesa_b2c_requests_status_valid",
      sql`${t.status} IN ('pending', 'completed', 'failed')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/**
 * Stripe Checkout — the card rail for organizations paying outside Kenya.
 * Deliberately the same shape as `mpesa_transactions`: one row per attempt,
 * a UNIQUE provider-side id (`checkout_session_id`) as the webhook key, and
 * the same three-state status, so tier grants can be written once for both
 * rails (see src/billing/tiers.ts).
 */
export const stripeTransactions = pgTable(
  "stripe_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    checkoutSessionId: text("checkout_session_id").notNull().unique(),
    amount: text("amount").notNull(),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("pending"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    ...timestamps,
  },
  (t) => [
    index("stripe_transactions_org_idx").on(t.organizationId),
    index("stripe_transactions_session_idx").on(t.checkoutSessionId),
    check(
      "stripe_transactions_status_valid",
      sql`${t.status} IN ('pending', 'completed', 'failed')`,
    ),
    pgPolicy("stripe_transactions_read_access", {
      as: "permissive",
      for: "select",
      to: authenticatedRole,
      using: memberOfOrg(t.organizationId),
    }),
  ],
);
