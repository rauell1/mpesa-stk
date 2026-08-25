/**
 * STK Push (Lipa na M-PESA Online) — the prompt that appears on the
 * customer's phone.
 *
 * This is the one rail `mpesa-stk` itself covers end to end. If you want the
 * full lifecycle — idempotent initiation, callback dedup, poll fallback,
 * reconciliation — use the library instead and let this module handle only
 * the org/plan-tier side. See ../../README.md ("Relationship to the library").
 */

import { baseUrl, darajaFetch, eatTimestamp, loadConfig, normalisePhone, stkPassword, type DarajaConfig } from "./config.js";
import { getDarajaToken } from "./token.js";

export interface StkPushResult {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface StkPushParams {
  phoneNumber: string;
  /** Whole KES — Daraja rejects decimals on the STK endpoint. */
  amount: number;
  /**
   * Shown on the prompt and on the customer's statement. Daraja truncates
   * this at 12 characters, so a bare UUID is not usable here — pass a short
   * reference and attribute the payment by CheckoutRequestID instead.
   */
  accountReference: string;
  /** Truncated at 13 characters by Daraja. */
  description: string;
}

export async function initiateStkPush(
  params: StkPushParams,
  config: DarajaConfig = loadConfig(),
): Promise<StkPushResult> {
  const amount = Math.trunc(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`amount must be a positive whole number of KES, got ${params.amount}`);
  }

  const phone = normalisePhone(params.phoneNumber);
  const timestamp = eatTimestamp();
  const token = await getDarajaToken(config);

  const res = await darajaFetch(
    `${baseUrl(config.environment)}/mpesa/stkpush/v1/processrequest`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        BusinessShortCode: config.shortCode,
        Password: stkPassword(config.shortCode, config.passKey, timestamp),
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: config.shortCode,
        PhoneNumber: phone,
        CallBackURL: `${config.callbackBaseUrl}/api/webhooks/mpesa`,
        AccountReference: params.accountReference.slice(0, 12),
        TransactionDesc: params.description.slice(0, 13),
      }),
    },
    config.timeoutMs,
  );

  const body = (await res.json().catch(() => ({}))) as Partial<StkPushResult> & {
    errorCode?: string;
    errorMessage?: string;
  };

  if (!res.ok || body.errorCode) {
    throw new Error(
      `Daraja STK Push failed (HTTP ${res.status})${body.errorMessage ? `: ${body.errorMessage}` : ""}`,
    );
  }

  if (!body.CheckoutRequestID) {
    throw new Error("Daraja STK Push response contained no CheckoutRequestID");
  }

  return body as StkPushResult;
}
