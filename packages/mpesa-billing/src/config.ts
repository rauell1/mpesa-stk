/**
 * Daraja primitives and configuration loading.
 *
 * Every function here is pure and covered by tests — these are the pieces that
 * fail silently when they are wrong. A password hashed against a timestamp
 * built from the host's local clock comes back as "invalid credentials", not
 * "your server is not in Nairobi".
 */

import { publicEncrypt, constants as cryptoConstants } from 'node:crypto'
import {
  DEFAULT_CALLBACK_PATHS,
  type CallbackPaths,
  type DarajaConfig,
  type MpesaEnvironment,
  type StripeConfig,
} from './types.js'

export function baseUrl(environment: MpesaEnvironment): string {
  return environment === 'live'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke'
}

/**
 * `YYYYMMDDHHmmss` in East Africa Time. Daraja validates the STK password
 * against this exact string, so it is computed from UTC + 3 rather than from
 * whatever timezone the process happens to run in.
 */
export function eatTimestamp(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    String(eat.getUTCFullYear()) +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  )
}

/** base64(shortcode + passkey + timestamp) — the STK Push `Password` field. */
export function stkPassword(shortCode: string, passKey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64')
}

/**
 * B2C `SecurityCredential`: the initiator password RSA-encrypted (PKCS#1 v1.5)
 * under Safaricom's certificate for the environment, base64-encoded. Sandbox
 * and production ship different certificates; using the wrong one fails as a
 * generic credential error that reads like a bad password.
 */
export function securityCredential(initiatorPassword: string, certificatePem: string): string {
  return publicEncrypt(
    { key: certificatePem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(initiatorPassword),
  ).toString('base64')
}

/**
 * Normalise 07xx / 01xx / +2547xx / 2547xx to Daraja's 2547xxxxxxxx.
 * Daraja rejects anything else with a message that does not say so.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[^\d]/g, '')
  if (/^254[17]\d{8}$/.test(digits)) return digits
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`
  throw new Error(`'${input}' is not a valid Kenyan mobile number`)
}

/** Whole KES; Daraja rejects decimals on both STK Push and B2C. */
export function assertWholeAmount(amount: number): number {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(`amount must be a positive whole number, got ${String(amount)}`)
  }
  return amount
}

export function callbackPaths(config: DarajaConfig): CallbackPaths {
  return { ...DEFAULT_CALLBACK_PATHS, ...config.callbackPaths }
}

export function callbackUrl(config: DarajaConfig, path: keyof CallbackPaths): string {
  return `${config.callbackBaseUrl.replace(/\/+$/, '')}${callbackPaths(config)[path]}`
}

// ---------------------------------------------------------------------------
// Environment loading — optional. Construct the config objects yourself if
// your app centralises env parsing (most do).
// ---------------------------------------------------------------------------

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function darajaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DarajaConfig {
  const environment = (env['MPESA_ENVIRONMENT'] ?? 'sandbox') as MpesaEnvironment
  if (environment !== 'sandbox' && environment !== 'live') {
    throw new Error(`MPESA_ENVIRONMENT must be 'sandbox' or 'live', got '${environment}'`)
  }

  const config: DarajaConfig = {
    consumerKey: required(env, 'MPESA_CONSUMER_KEY'),
    consumerSecret: required(env, 'MPESA_CONSUMER_SECRET'),
    shortCode: required(env, 'MPESA_SHORTCODE'),
    passKey: required(env, 'MPESA_PASSKEY'),
    environment,
    callbackBaseUrl: required(env, 'MPESA_CALLBACK_BASE_URL'),
    timeoutMs: Number(env['MPESA_TIMEOUT_MS'] ?? 30_000),
  }

  if (env['MPESA_INITIATOR_NAME']) config.initiatorName = env['MPESA_INITIATOR_NAME']
  if (env['MPESA_INITIATOR_PASSWORD']) config.initiatorPassword = env['MPESA_INITIATOR_PASSWORD']
  if (env['MPESA_SECURITY_CERTIFICATE']) config.securityCertificate = env['MPESA_SECURITY_CERTIFICATE']

  return config
}

export function stripeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  return {
    secretKey: required(env, 'STRIPE_SECRET_KEY'),
    webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    toleranceSeconds: Number(env['STRIPE_WEBHOOK_TOLERANCE_SECONDS'] ?? 300),
    timeoutMs: Number(env['STRIPE_TIMEOUT_MS'] ?? 30_000),
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
