-- The application's half of the schema. The payment tables themselves are
-- created by PostgresStore.migrate() — this is only what SafariCharge adds so
-- a settled payment has somewhere to land.
--
-- Idempotent: safe to re-run.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_tier text DEFAULT 'free' NOT NULL;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;

-- `reference` on billing_payments holds the organization id. It is text, not a
-- foreign key, because the package is not allowed to know what it points at —
-- so this index is what keeps "payments for this organization" cheap.
CREATE INDEX IF NOT EXISTS billing_payments_reference_idx ON billing_payments (reference);

-- Row-level security, if your app reads payment rows from the client. The
-- webhook handlers write over a service role that bypasses these.
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_payments_read_access ON billing_payments;
CREATE POLICY billing_payments_read_access ON billing_payments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    (SELECT auth_user_id FROM organization_members
      WHERE organization_id = billing_payments.reference::uuid
        AND auth_user_id = auth.user_id()) IS NOT NULL
  );
