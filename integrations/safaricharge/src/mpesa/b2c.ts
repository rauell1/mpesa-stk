/**
 * B2C — paying money out of the shortcode to a customer (refunds, rebates).
 *
 * Daraja answers the initiation request with an acknowledgement only; the
 * outcome arrives later on the result URL, or on the timeout URL if the
 * request died in Safaricom's queue. Both are handled in
 * routes/nextjs/webhooks/mpesa/b2c/.
 */

import { baseUrl, darajaFetch, loadConfig, normalisePhone, securityCredential, type DarajaConfig } from "./config.js";
import { getDarajaToken } from "./token.js";

export type B2CCommand = "BusinessPayment" | "SalaryPayment" | "PromotionPayment";

export interface B2CResult {
  ConversationID: string;
  OriginatorConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

export interface B2CParams {
  phoneNumber: string;
  amount: number;
  remarks: string;
  occasion?: string;
  /** Default BusinessPayment — a refund, not salary or a promotion. */
  commandId?: B2CCommand;
}

export async function initiateB2C(
  params: B2CParams,
  config: DarajaConfig = loadConfig(),
): Promise<B2CResult> {
  const { initiatorName, initiatorPassword, securityCertificate } = config;
  if (!initiatorName || !initiatorPassword || !securityCertificate) {
    throw new Error(
      "B2C requires MPESA_INITIATOR_NAME, MPESA_INITIATOR_PASSWORD and MPESA_SECURITY_CERTIFICATE",
    );
  }

  const amount = Math.trunc(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`amount must be a positive whole number of KES, got ${params.amount}`);
  }

  const token = await getDarajaToken(config);

  const res = await darajaFetch(
    `${baseUrl(config.environment)}/mpesa/b2c/v1/paymentrequest`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential(initiatorPassword, securityCertificate),
        CommandID: params.commandId ?? "BusinessPayment",
        Amount: amount,
        PartyA: config.shortCode,
        PartyB: normalisePhone(params.phoneNumber),
        Remarks: params.remarks.slice(0, 100),
        QueueTimeOutURL: `${config.callbackBaseUrl}/api/webhooks/mpesa/b2c/timeout`,
        ResultURL: `${config.callbackBaseUrl}/api/webhooks/mpesa/b2c/result`,
        Occasion: (params.occasion ?? "").slice(0, 100),
      }),
    },
    config.timeoutMs,
  );

  const body = (await res.json().catch(() => ({}))) as Partial<B2CResult> & {
    errorMessage?: string;
  };

  if (!res.ok || body.ResponseCode !== "0") {
    throw new Error(
      `Daraja B2C request failed (HTTP ${res.status})${body.errorMessage ?? body.ResponseDescription ? `: ${body.errorMessage ?? body.ResponseDescription}` : ""}`,
    );
  }

  if (!body.ConversationID) {
    throw new Error("Daraja B2C response contained no ConversationID");
  }

  return body as B2CResult;
}

/** Payload Safaricom POSTs to the B2C result URL. */
export interface B2CResultPayload {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID: string;
    ResultParameters?: {
      ResultParameter: Array<{ Key: string; Value?: string | number }>;
    };
  };
}
