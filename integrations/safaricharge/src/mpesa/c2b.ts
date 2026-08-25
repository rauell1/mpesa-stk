/**
 * C2B — customers paying the shortcode directly from their own phones
 * (Pay Bill / Buy Goods), with the organization id as the account number.
 *
 * Unlike STK Push, nothing is initiated from our side: Safaricom calls the
 * validation URL before moving money and the confirmation URL after. The URLs
 * are registered once per shortcode; re-registering is harmless and is how
 * you move callbacks after a domain change.
 */

import { baseUrl, darajaFetch, loadConfig, type DarajaConfig } from "./config.js";
import { getDarajaToken } from "./token.js";

export interface RegisterUrlResult {
  OriginatorCoversationID?: string;
  ResponseCode: string;
  ResponseDescription: string;
}

/**
 * `ResponseType` is what Safaricom does when the validation URL is
 * unreachable: "Completed" auto-accepts the payment, "Cancelled" rejects it.
 * We use Cancelled — an unreachable validator means we cannot tell which
 * organization the money belongs to, and an unattributed payment is worse
 * than a declined one.
 */
export async function registerC2BUrls(
  config: DarajaConfig = loadConfig(),
  responseType: "Completed" | "Cancelled" = "Cancelled",
): Promise<RegisterUrlResult> {
  const token = await getDarajaToken(config);

  const res = await darajaFetch(
    `${baseUrl(config.environment)}/mpesa/c2b/v1/registerurl`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ShortCode: config.shortCode,
        ResponseType: responseType,
        ConfirmationURL: `${config.callbackBaseUrl}/api/webhooks/mpesa/c2b/confirmation`,
        ValidationURL: `${config.callbackBaseUrl}/api/webhooks/mpesa/c2b/validation`,
      }),
    },
    config.timeoutMs,
  );

  const body = (await res.json().catch(() => ({}))) as Partial<RegisterUrlResult> & {
    errorMessage?: string;
  };

  if (!res.ok || body.ResponseCode !== "0") {
    throw new Error(
      `C2B URL registration failed (HTTP ${res.status})${body.errorMessage ?? body.ResponseDescription ? `: ${body.errorMessage ?? body.ResponseDescription}` : ""}`,
    );
  }

  return body as RegisterUrlResult;
}

/** Payload Safaricom POSTs to both the validation and confirmation URLs. */
export interface C2BCallbackPayload {
  TransactionType?: string;
  TransID: string;
  TransTime?: string;
  TransAmount: string;
  BusinessShortCode?: string;
  BillRefNumber?: string;
  InvoiceNumber?: string;
  OrgAccountBalance?: string;
  ThirdPartyTransID?: string;
  MSISDN: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
}
