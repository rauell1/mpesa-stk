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
 * Repair a PEM that travelled through an environment variable.
 *
 * Only dotenv expands `\n` inside a double-quoted value. Docker, Kubernetes,
 * systemd, Vercel, and GitHub Actions secrets all hand the process the two
 * characters `\` and `n`, and OpenSSL then rejects the certificate with
 * `error:1E08010C:DECODER routines::unsupported` — which reads like a bad
 * certificate rather than a bad newline. Normalising here costs nothing for a
 * PEM that already has real newlines.
 */
export function normalisePem(pem: string): string {
  const repaired = pem.trim().replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n/g, '\n')
  if (!repaired.includes('-----BEGIN')) {
    throw new Error('Security certificate is not PEM — expected a "-----BEGIN …-----" block')
  }
  return repaired.endsWith('\n') ? repaired : `${repaired}\n`
}

/**
 * Payout `SecurityCredential`: the initiator password RSA-encrypted (PKCS#1
 * v1.5) under Safaricom's certificate for the environment, base64-encoded.
 * Sandbox and production ship different certificates; using the wrong one
 * fails as a generic credential error that reads like a bad password.
 */
export function securityCredential(initiatorPassword: string, certificatePem: string): string {
  return publicEncrypt(
    { key: normalisePem(certificatePem), padding: cryptoConstants.RSA_PKCS1_PADDING },
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

/** A paybill, till, or organisation shortcode: 5–7 digits, as Daraja issues them. */
export function assertShortCode(input: string, field = 'shortcode'): string {
  const digits = input.trim()
  if (!/^\d{5,7}$/.test(digits)) {
    throw new Error(`'${input}' is not a valid ${field} — expected 5 to 7 digits`)
  }
  return digits
}

export function callbackPaths(config: DarajaConfig): CallbackPaths {
  return { ...DEFAULT_CALLBACK_PATHS, ...config.callbackPaths }
}

export function callbackUrl(config: DarajaConfig, path: keyof CallbackPaths): string {
  return `${config.callbackBaseUrl.replace(/\/+$/, '')}${callbackPaths(config)[path]}`
}

// ---------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------

/**
 * The IP ranges Safaricom delivers callbacks from, as published in the Daraja
 * portal. Safaricom signs nothing, so for the C2B confirmation — the one
 * delivery that creates a settled payment from scratch — this is the only
 * evidence that a request is genuine.
 *
 * Enforce it at your WAF or CDN if you have one. Where you do not, pass
 * `trustedMpesaIps: SAFARICOM_CALLBACK_CIDRS` to `Billing` and give the
 * handlers a `sourceIp`.
 */
export const SAFARICOM_CALLBACK_CIDRS: readonly string[] = [
  '196.201.214.200/28',
  '196.201.214.216/29',
  '196.201.214.232/30',
  '196.201.214.236/32',
  '196.201.214.238/32',
  '196.201.214.240/30',
  '196.201.214.244/32',
  '196.201.214.246/32',
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/**
 * Is `ip` inside any of these CIDR blocks? IPv4 only — Safaricom publishes no
 * IPv6 ranges — and an IPv4-mapped IPv6 address (`::ffff:196.201.214.200`) is
 * unwrapped first, because that is how Node reports one on a dual-stack
 * socket.
 */
export function isIpAllowed(ip: string | undefined, cidrs: readonly string[]): boolean {
  if (!ip) return false
  const bare = ip.trim().replace(/^::ffff:/i, '')
  const address = ipv4ToInt(bare)
  if (address === null) return false

  return cidrs.some((cidr) => {
    const [network, bitsText] = cidr.split('/')
    if (!network) return false
    const base = ipv4ToInt(network)
    if (base === null) return false
    const bits = bitsText === undefined ? 32 : Number(bitsText)
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
    if (bits === 0) return true
    // >>> 0 keeps the mask unsigned; a signed shift would break /1 upwards.
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return (address & mask) >>> 0 === (base & mask) >>> 0
  })
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

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`)
  }
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
    shortCode: assertShortCode(required(env, 'MPESA_SHORTCODE'), 'MPESA_SHORTCODE'),
    passKey: required(env, 'MPESA_PASSKEY'),
    environment,
    callbackBaseUrl: required(env, 'MPESA_CALLBACK_BASE_URL'),
    timeoutMs: positiveInt(env, 'MPESA_TIMEOUT_MS', 30_000),
  }

  if (env['MPESA_INITIATOR_NAME']) config.initiatorName = env['MPESA_INITIATOR_NAME']
  if (env['MPESA_INITIATOR_PASSWORD']) config.initiatorPassword = env['MPESA_INITIATOR_PASSWORD']
  // Normalised on the way in so a broken certificate fails at boot, with a
  // message that names the certificate, rather than on the first payout.
  if (env['MPESA_SECURITY_CERTIFICATE']) {
    config.securityCertificate = normalisePem(env['MPESA_SECURITY_CERTIFICATE'])
  }

  return config
}

export function stripeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  return {
    secretKey: required(env, 'STRIPE_SECRET_KEY'),
    webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    toleranceSeconds: positiveInt(env, 'STRIPE_WEBHOOK_TOLERANCE_SECONDS', 300),
    timeoutMs: positiveInt(env, 'STRIPE_TIMEOUT_MS', 30_000),
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
