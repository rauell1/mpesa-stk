-- Billing rails: M-PESA (STK Push, C2B, B2C, token cache) and Stripe Checkout.
--
-- Standalone consolidation of SafariCharge's drizzle/0013, 0014 and 0015 —
-- billing objects only; the RLS enablement those migrations also applied to
-- unrelated application tables is left out.
--
-- Assumes `organizations` and `organization_members` already exist, and that
-- the `authenticated` role and an `auth.user_id()` function are provided by
-- the auth layer (Neon Auth / Supabase). Idempotent: safe to re-run.

-- Plan tier on the organization ------------------------------------------------

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "plan_tier" text DEFAULT 'free' NOT NULL;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "plan_expires_at" timestamp with time zone;

-- M-PESA: STK Push --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "mpesa_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"checkout_request_id" text NOT NULL,
	"amount" text NOT NULL,
	"phone_number" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"receipt_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_transactions_checkout_request_id_unique" UNIQUE("checkout_request_id"),
	CONSTRAINT "mpesa_transactions_status_valid" CHECK ("mpesa_transactions"."status" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "mpesa_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);

ALTER TABLE "mpesa_transactions" ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS "mpesa_transactions_org_idx" ON "mpesa_transactions" USING btree ("organization_id");
CREATE INDEX IF NOT EXISTS "mpesa_transactions_status_idx" ON "mpesa_transactions" USING btree ("status");

-- M-PESA: Daraja OAuth token cache ---------------------------------------------

CREATE TABLE IF NOT EXISTS "mpesa_auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "mpesa_auth_tokens_env_expiry_idx" ON "mpesa_auth_tokens" USING btree ("environment", "expires_at");

-- M-PESA: C2B -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "mpesa_c2b_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trans_id" text NOT NULL,
	"trans_amount" text NOT NULL,
	"bill_ref_number" text NOT NULL,
	"msisdn" text NOT NULL,
	"first_name" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_c2b_transactions_trans_id_unique" UNIQUE("trans_id"),
	CONSTRAINT "mpesa_c2b_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);

ALTER TABLE "mpesa_c2b_transactions" ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS "mpesa_c2b_transactions_org_idx" ON "mpesa_c2b_transactions" USING btree ("organization_id");
CREATE INDEX IF NOT EXISTS "mpesa_c2b_transactions_trans_idx" ON "mpesa_c2b_transactions" USING btree ("trans_id");

-- M-PESA: B2C -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "mpesa_b2c_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text,
	"originator_conversation_id" text,
	"amount" text NOT NULL,
	"phone_number" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_b2c_requests_conversation_id_unique" UNIQUE("conversation_id"),
	CONSTRAINT "mpesa_b2c_requests_originator_conversation_id_unique" UNIQUE("originator_conversation_id"),
	CONSTRAINT "mpesa_b2c_requests_status_valid" CHECK ("mpesa_b2c_requests"."status" IN ('pending', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS "mpesa_b2c_requests_status_idx" ON "mpesa_b2c_requests" USING btree ("status");

-- Stripe: Checkout ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "stripe_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"checkout_session_id" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_payment_intent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_transactions_checkout_session_id_unique" UNIQUE("checkout_session_id"),
	CONSTRAINT "stripe_transactions_status_valid" CHECK ("stripe_transactions"."status" IN ('pending', 'completed', 'failed')),
	CONSTRAINT "stripe_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);

ALTER TABLE "stripe_transactions" ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS "stripe_transactions_org_idx" ON "stripe_transactions" USING btree ("organization_id");
CREATE INDEX IF NOT EXISTS "stripe_transactions_session_idx" ON "stripe_transactions" USING btree ("checkout_session_id");

-- Read policies ------------------------------------------------------------------
-- Members of the owning organization may read their own payment rows. Writes
-- come from the webhook handlers over a service role that bypasses RLS.

DROP POLICY IF EXISTS "mpesa_transactions_read_access" ON "mpesa_transactions";
CREATE POLICY "mpesa_transactions_read_access" ON "mpesa_transactions" AS PERMISSIVE FOR SELECT TO "authenticated"
	USING ((select auth_user_id from "organization_members" where organization_id = "mpesa_transactions"."organization_id" and auth_user_id = auth.user_id()) is not null);

DROP POLICY IF EXISTS "mpesa_c2b_transactions_read_access" ON "mpesa_c2b_transactions";
CREATE POLICY "mpesa_c2b_transactions_read_access" ON "mpesa_c2b_transactions" AS PERMISSIVE FOR SELECT TO "authenticated"
	USING ((select auth_user_id from "organization_members" where organization_id = "mpesa_c2b_transactions"."organization_id" and auth_user_id = auth.user_id()) is not null);

DROP POLICY IF EXISTS "stripe_transactions_read_access" ON "stripe_transactions";
CREATE POLICY "stripe_transactions_read_access" ON "stripe_transactions" AS PERMISSIVE FOR SELECT TO "authenticated"
	USING ((select auth_user_id from "organization_members" where organization_id = "stripe_transactions"."organization_id" and auth_user_id = auth.user_id()) is not null);
