# Changelog

## Unreleased

Repository refocused on being a general-purpose M-PESA SDK: the application-specific
example is gone, `mpesa-billing` gains the B2B rail, and every amount now carries its
currency.

### `mpesa-billing`

#### Added

- **B2B rail.** `initiateB2B` pays another business's paybill or till, with
  `handleB2BResult` / `handleB2BTimeout` settling through the same
  compare-and-swap as every other rail. Supports `BusinessPayBill`,
  `BusinessBuyGoods`, `DisburseFundsToBusiness`, and
  `BusinessToBusinessTransfer`. Three B2B-specific wire-format traps are handled:
  the operator field is `Initiator` (not `InitiatorName`), `PartyB` is a shortcode
  and must not be phone-normalised, and Safaricom's field is spelled
  `RecieverIdentifierType`.
- **`Money`** — every amount is now `{ currency, minor }`: an ISO-4217 code and an
  integer count of minor units. Decimal strings are parsed digit by digit (no
  `19.99 * 100` drift), zero- and three-decimal currencies are handled, and excess
  precision throws instead of being truncated.
- **`settledAmount`** on every payment: what the provider says actually moved, kept
  alongside the requested `amount`. On C2B, where the customer types the amount,
  these routinely differ.
- **`trustedMpesaIps`** plus `SAFARICOM_CALLBACK_CIDRS` and `isIpAllowed`. Safaricom
  signs nothing, so the published callback ranges stand in for a signature. Opt-in.
- `getPayment` / `getPaymentByReference` on the `Billing` facade.
- `transactionType` on `initiateStkPush`, for till (`CustomerBuyGoodsOnline`) as well
  as paybill payments.

#### Fixed

- **Payout results dropped the receipt and the amount.** `parseB2CResult` read only
  `Result.TransactionID` and never touched `ResultParameters`, where Daraja actually
  puts `TransactionReceipt`, `TransactionAmount`, and `ReceiverPartyPublicName`. Now
  parsed, including the single-object shape Safaricom sends when there is one
  parameter. Renamed to `parsePayoutResult` (B2C and B2B share the envelope);
  `parseB2CResult` remains as an alias.
- **A security certificate supplied through an environment variable failed.**
  `env.example` documents `MPESA_SECURITY_CERTIFICATE` with `\n` escapes, but only
  dotenv expands those — Docker, Kubernetes, Vercel, and GitHub Actions hand over the
  literal characters, and OpenSSL then rejected the PEM with
  `error:1E08010C:DECODER routines::unsupported`. `normalisePem` repairs either form,
  and `darajaConfigFromEnv` applies it at boot so a bad certificate fails at startup
  rather than on the first payout.
- **A Stripe webhook arriving with no Stripe config returned an unhandled throw.** Now
  a 500, so Stripe retries once the configuration is fixed rather than the delivery
  being lost.
- `MPESA_TIMEOUT_MS` and the Stripe timeouts silently became `NaN` when unparseable;
  they are now validated. `MPESA_SHORTCODE` is checked to be a shortcode.
- STK `ResultCode` arriving as a numeric string is now accepted rather than dropping
  the callback; a C2B `TransAmount` that cannot be read as money now rejects the
  delivery rather than recording a payment of nothing.

#### Changed

- **Breaking:** `BillingPayment.amount` is a `Money`, not a string, and the separate
  `currency` field is gone. Rail APIs take `{ amount, currency }` or
  `{ minor, currency }`; a bare number is refused.
- **Breaking:** the Postgres schema stores `amount_minor BIGINT` + `currency CHAR(3)`
  in place of `amount NUMERIC(14,2)`, with `settled_amount_minor` / `settled_currency`
  alongside and a constraint that neither exists without the other. `migrate()` adds
  the new columns to an existing table.
- Webhook handlers take an optional `WebhookContext` second argument; `createWebhookRoutes`
  fills it from a configurable header.
- `assertWholeAmount` is replaced by `toDarajaAmount`, which also enforces KES.

#### Tests

- 71 → 215. New suites for `Money`, B2B settlement and its wire format, the whole
  outbound Daraja layer (previously untested), the Postgres adapter (previously
  untested), and caller verification.

### Repository

- **Removed the SafariCharge example** — its multi-tenant plan tiers, organization
  tables, and RLS migration were specific to one application. Replaced by
  `examples/billing-node/`, which shows the same wiring with no domain attached.
- Bumped `hono` and `@hono/node-server`, which the relay depends on at runtime, past
  their advisories.
- `repository`, `bugs`, and `homepage` now point at this repository.

## [0.3.1] — 2026-06-21

Docs only — no code change.

- Trimmed the README (235 → 112 lines) to what/why/how/usage, grounded in the live-sandbox findings.
- Restored the reconciliation drift table, corrected: the "ghost credit" (your DB `SUCCESS`, Daraja has no record) and transient `4999`/`429` cases surface as `skipped`, not mismatches — `reconcile` never reports a status it can't read.
- Replaced the stale `~10 req/s` reconciliation rate-limit note with the observed Apigee SpikeArrest (5 req/60s, burst 1) and the `429` backoff behaviour.
- Fixed the documented poll schedule to match `pollIntervalMs`, and the dedup section now leads with the atomic CAS.
- Marked the STK Query endpoint path and rate limit as verified in sandbox; documented the `4999` transient code.

## [0.3.0] — 2026-06-21

Reliability fixes found by stress-testing against the live Daraja sandbox.

### Fixed

- **Concurrent same-key initiations no longer double-charge.** `initiatePayment` calls with the same `idempotencyKey` that race in the same process now share one in-flight STK Push instead of each sending their own. A double-tapped "Pay" or a retried request reaches Daraja once. (The old in-process `Set` guard never actually waited.)
- **Poll no longer marks pending payments FAILED on a transient query code.** The STK Query endpoint returns transient codes (e.g. `4999`, observed in sandbox) for a transaction that hasn't settled. The poll loop now settles only on a known-terminal code; `4999`, unrecognised codes, and `NaN` keep polling and resolve as `TIMEOUT`, which reconciliation then verifies.
- **Reconciliation backs off on rate limiting instead of skipping.** The STK Query endpoint is behind an Apigee SpikeArrest policy (5 req/60s, burst 1 in sandbox). A `429` now raises a typed `DarajaRateLimitError`; reconcile retries the same payment with exponential backoff (honouring `Retry-After`) rather than counting it as unverified.

### Changed

- **Phone validation restricted to Kenyan mobile prefixes** (`07x`, `010`, `011`). Non-mobile inputs (landline `02x`, common `05x`/`09x` typos) are rejected locally instead of being forwarded to Daraja to fail opaquely.
- **`pollIntervalMs` now drives the poll backoff.** It was documented but unused. The poll waits one interval before the first query, then a Fibonacci backoff (×1, 2, 3, 5, 8, 13, 21) capped at 30s — e.g. 5s → 10s → 15s → 25s → 30s at the default.

### Tests

- New coverage for the relay delivery engine (retry ladder, dead-lettering, outbound signing, restart recovery), webhook signature verification, true-concurrency dedup/idempotency, and real-world callback shapes (unordered metadata, string `TransactionDate`/`Amount`). 163 → 218 tests.

## [0.2.0] — 2026-04-03

### Added

- **Webhook relay server** (`mpesa-stk/server`) — the missing reliability layer between Safaricom and your app. Safaricom fires your `CallbackURL` once with no retry. The relay receives that callback, validates it, deduplicates it, persists it, and delivers it to your app with exponential-backoff retries (immediate → 30s → 2m → 10m → 30m → 2h → dead letter).

- `createRelayServer(config)` — returns a Hono app with four routes:
  - `POST /apps` — register an app, get back `appId` + `signingSecret`
  - `PATCH /apps/:appId` — update your target URL after a deploy
  - `POST /hooks/:appId` — point your Safaricom `CallbackURL` here
  - `GET /status/:checkoutRequestId?app_id=` — query delivery status

- `PostgresRelayAdapter` — relay storage over two new tables (`relay_apps`, `relay_delivery_events`). Completely separate from `mpesa_payments` — adopting the relay requires no schema changes to your existing setup.

- `recoverPendingDeliveries(storage)` — call on startup to reschedule any deliveries that were in-flight when the server last stopped. The `nextAttemptAt` column persists intent to Postgres so no delivery is permanently lost to a process restart.

- `signBody(body, secret)` / `verifySignature(body, secret, sig)` — HMAC-SHA256 signing helpers. The relay signs every outbound delivery; your app verifies it. Safaricom sends unsigned callbacks — without this, anyone who discovers your endpoint URL can POST fake success payloads.

- **Standalone binary** (`npx mpesa-stk-relay`) — run the relay as a self-contained process with `DATABASE_URL` and `PORT`. Migrates tables on startup, recovers in-flight deliveries, and runs a 60-second sweep interval as a backstop. Logs as newline-delimited JSON.

### Changed

- `tsup.config.ts` split into two build targets: library (ESM + CJS + types, Hono external) and binary (bundled CJS with shebang, pg external).
- `package.json` gains `bin.mpesa-stk-relay`, `exports["./server"]`, and `hono` + `@hono/node-server` as runtime dependencies.

### Notes

The core `MpesaStk` class, all adapters, and the full test suite are unchanged. This release is purely additive — existing integrations require no changes.

---

## [0.1.1] — 2026-03-26

### Fixed

- Corrected repository URL in `package.json` to `ronnyabuto/mpesa-stk`.
- Switched build tool to `tsup` for dual CJS + ESM output with proper `.d.ts` generation.

---

## [0.1.0] — 2026-03-24

### Added

- `MpesaStk` class — idempotent STK Push initiation, callback processing, polling fallback, reconciliation.
- `PostgresAdapter` — storage over `mpesa_payments` table with atomic `settlePayment` (compare-and-swap deduplication).
- `MemoryAdapter` — in-memory adapter for testing.
- Phone number normalisation accepting 6 input formats → `254xxxxxxxxx`.
- Result code mapping: `0` → SUCCESS, `1032` → CANCELLED, `1037` → TIMEOUT, `1019` → EXPIRED, others → FAILED. `TIMEOUT` is explicitly not a failure — money may have moved.
- Callback amount validation with ±1 KES tolerance.
- `StorageAdapter` interface for custom storage backends.
