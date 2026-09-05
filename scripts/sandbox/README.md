# Daraja sandbox smoke test

The unit tests in this repository cannot tell you whether the M-PESA integration
works. They assert that the code sends **what we believe Daraja wants**, against
a mocked `fetch`. If that belief is wrong, the test encodes the same wrong belief
and passes. Every reference to `safaricom.co.ke` in the test suite is a string
comparison; no test has ever opened a socket to Safaricom.

These two scripts close that gap. They send the library's real requests to the
real sandbox and feed the real callbacks back into the library's real handlers.

| Script | Verifies |
|---|---|
| `smoke.ts` | **Outbound** — does Daraja accept what we send? |
| `callback-sink.ts` | **Inbound** — do we understand what Daraja sends back? |

Both write everything Safaricom produces to `captured/`, so a genuine payload can
replace a hand-written test fixture.

## Setup

You need Daraja **sandbox** credentials from <https://developer.safaricom.co.ke>
(create an app, then open the test credentials page for your shortcode).

```bash
cp packages/mpesa-billing/env.example .env
```

Minimum, for STK Push and C2B:

```bash
MPESA_ENVIRONMENT=sandbox
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=174379          # the Daraja sandbox paybill
MPESA_PASSKEY=...
MPESA_CALLBACK_BASE_URL=https://your-tunnel.example.com
```

Add these for the payout rails (B2C and B2B):

```bash
MPESA_INITIATOR_NAME=testapi
MPESA_INITIATOR_PASSWORD=...            # sandbox initiator password
MPESA_SECURITY_CERTIFICATE="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
MPESA_TEST_RECEIVER_SHORTCODE=600000    # a second sandbox shortcode, for B2B
```

Optional:

```bash
MPESA_TEST_MSISDN=254708374149   # defaults to Safaricom's sandbox test number
DATABASE_URL=postgres://...      # makes the sink a true end-to-end test
SINK_PORT=3010
```

The certificate can carry literal `\n` escapes — the library repairs them.

## Running it

**Terminal 1** — the sink, and a tunnel so Safaricom can reach it:

```bash
npm run sandbox:sink
cloudflared tunnel --url http://localhost:3010     # or: ngrok http 3010
```

Set `MPESA_CALLBACK_BASE_URL` to the public `https://` origin the tunnel prints.
Safaricom will not call `http://` or `localhost`.

**Terminal 2** — the smoke run:

```bash
npm run sandbox:smoke
```

## What it does

| Check | Rail | Notes |
|---|---|---|
| `oauth` | — | Everything else is meaningless if this fails, so the run stops here |
| `stk-push` | STK | KES 1 to the test MSISDN |
| `stk-query` | STK | Confirms the push exists on Daraja's side, not just ours |
| `c2b-register` | C2B | Registers the validation and confirmation URLs |
| `c2b-simulate` | C2B | Sandbox-only; makes Safaricom act as a paying customer, which is the only way to provoke a genuine callback pair |
| `b2c` | B2C | KES 1 payout to the test MSISDN |
| `b2b` | B2B | KES 1 to `MPESA_TEST_RECEIVER_SHORTCODE` |

Checks whose prerequisites are missing are reported `SKIP`, not silently passed.
The run exits non-zero if anything fails.

Every rail uses **the library's own functions**, so a pass is evidence about the
shipped code path. Two exceptions are marked `SANDBOX HELPER` in the source — the
STK Query and the C2B simulate endpoint, which this package does not wrap but
which are needed to provoke a real callback.

## Reading the sink

For each delivery the sink reports three things separately, which matters:

```
▼ /api/webhooks/mpesa/b2b/result
   parsed:  yes — code 0, receipt QKA81LK5CY, amount 1.00, params [Amount, ReceiverPartyPublicName]
   settled: nothing — no matching payment here, or already terminal
   replied: 200 {"ResultCode":"0","ResultDesc":"Acknowledged"}
   saved:   scripts/sandbox/captured/…__callback-mpesa-b2b-result.json
```

- **`parsed`** is the real finding. It says whether the library understood a
  genuine Safaricom payload, and shows what it pulled out. `NO — parseX returned
  null` on a real callback is a bug in the parser.
- **`settled`** will usually say *nothing* under `MemoryStore`, because the smoke
  script runs in a **different process** and this store never saw the payment it
  created. That is expected and is not a failure.
- **`params [...]`** lists the `ResultParameter` keys Safaricom actually sent.
  Compare it against what the parser looks for — that is how you find out the
  docs were wrong.

Set `DATABASE_URL` to make `settled` meaningful: the sink then uses
`PostgresStore`, both processes share state, the migration actually executes, and
the compare-and-swap runs in real SQL. That converts this from a parse check into
a genuine end-to-end test — and it is the only thing that has ever run the
migration DDL.

## Safety

`smoke.ts` **refuses to run unless `MPESA_ENVIRONMENT=sandbox`** and exits with
code 2 otherwise. It initiates payments and, on B2C and B2B, moves money *out* —
a mistyped environment variable should not be able to pay a stranger. Every
amount is KES 1 for the same reason.

The sink deliberately does **not** enable `trustedMpesaIps`: a tunnel rewrites
the source address, so the check would reject every genuine delivery and teach
you nothing. Enable it in your real app, behind a proxy you control.

`captured/` is gitignored. Sandbox payloads are not sensitive, but production
ones would be, and the habit is worth keeping.

## Turning findings into tests

That is the point of `captured/`. When a real payload differs from what the suite
assumes, copy it into a test as a fixture and fix the parser. A test built from a
payload Safaricom actually sent is worth more than any number built from the
documentation.
