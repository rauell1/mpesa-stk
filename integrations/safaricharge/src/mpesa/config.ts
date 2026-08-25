/**
 * Daraja configuration and the primitives every M-PESA call needs.
 *
 * Read from the environment once per call rather than at module load: route
 * handlers are re-instantiated across serverless invocations, and a missing
 * variable should fail the request that needs it, not the whole bundle.
 */

import { publicEncrypt, constants as cryptoConstants } from "node:crypto";

export type MpesaEnvironment = "sandbox" | "live";

export interface DarajaConfig {
  consumerKey: string;
  consumerSecret: string;
  /** Lipa na M-PESA Online shortcode (paybill or till). */
  shortCode: string;
  /** STK Push passkey, from the Daraja portal. */
  passKey: string;
  environment: MpesaEnvironment;
  /** Public base URL of this app; callbacks are built from it. */
  callbackBaseUrl: string;
  /** B2C only — the API operator username. */
  initiatorName?: string;
  /** B2C only — the operator's plaintext password, encrypted per request. */
  initiatorPassword?: string;
  /** B2C only — Safaricom's public certificate (PEM) for the environment. */
  securityCertificate?: string;
  /** Wall-clock budget for a single Daraja call (default 30s). */
  timeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(): DarajaConfig {
  const environment = (process.env["MPESA_ENVIRONMENT"] ?? "sandbox") as MpesaEnvironment;
  if (environment !== "sandbox" && environment !== "live") {
    throw new Error(`MPESA_ENVIRONMENT must be 'sandbox' or 'live', got '${environment}'`);
  }

  return {
    consumerKey: required("MPESA_CONSUMER_KEY"),
    consumerSecret: required("MPESA_CONSUMER_SECRET"),
    shortCode: required("MPESA_SHORTCODE"),
    passKey: required("MPESA_PASSKEY"),
    environment,
    callbackBaseUrl: required("MPESA_CALLBACK_BASE_URL").replace(/\/+$/, ""),
    ...(process.env["MPESA_INITIATOR_NAME"] ? { initiatorName: process.env["MPESA_INITIATOR_NAME"] } : {}),
    ...(process.env["MPESA_INITIATOR_PASSWORD"] ? { initiatorPassword: process.env["MPESA_INITIATOR_PASSWORD"] } : {}),
    ...(process.env["MPESA_SECURITY_CERTIFICATE"] ? { securityCertificate: process.env["MPESA_SECURITY_CERTIFICATE"] } : {}),
    timeoutMs: Number(process.env["MPESA_TIMEOUT_MS"] ?? 30_000),
  };
}

export function baseUrl(environment: MpesaEnvironment): string {
  return environment === "live"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

/**
 * Daraja timestamps are `YYYYMMDDHHmmss` in East Africa Time, and the
 * password hash is validated against them — building the string from the
 * server's local clock breaks the moment the host is not on UTC+3.
 */
export function eatTimestamp(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(eat.getUTCFullYear()) +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
}

/** base64(shortcode + passkey + timestamp) — the STK Push `Password` field. */
export function stkPassword(shortCode: string, passKey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passKey}${timestamp}`).toString("base64");
}

/**
 * B2C `SecurityCredential`: the initiator password RSA-encrypted (PKCS#1 v1.5)
 * with Safaricom's environment certificate, base64-encoded. Sandbox and
 * production use different certificates — encrypting with the wrong one fails
 * with a generic "invalid credential" that is easy to misread as a bad password.
 */
export function securityCredential(initiatorPassword: string, certificatePem: string): string {
  return publicEncrypt(
    { key: certificatePem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(initiatorPassword),
  ).toString("base64");
}

/**
 * Normalise 07xx / 01xx / +2547xx / 2547xx to Daraja's 2547xxxxxxxx.
 * Daraja rejects everything else, so do it before the request rather than
 * reading the failure back out of a ResponseDescription.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d]/g, "");
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  throw new Error(`'${input}' is not a valid Kenyan mobile number`);
}

export async function darajaFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
