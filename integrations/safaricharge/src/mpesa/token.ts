/**
 * Daraja OAuth access tokens, cached in Postgres.
 *
 * Daraja issues a bearer token that lives 3599s and rate-limits the token
 * endpoint itself, so minting one per request is both slow and a way to get
 * throttled mid-checkout. The cache is shared across processes — a serverless
 * deployment has no in-memory cache worth the name.
 */

import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "../../db/client.js";
import { mpesaAuthTokens } from "../../db/schema.js";
import { baseUrl, darajaFetch, loadConfig, type DarajaConfig } from "./config.js";

/**
 * Discard a cached token this many ms before Daraja expires it. A token that
 * is valid when read but expires in flight returns 401 from the payment call,
 * which is far more expensive than minting one a minute early.
 */
const EXPIRY_MARGIN_MS = 60_000;

interface DarajaTokenResponse {
  access_token: string;
  expires_in: string;
}

export async function getDarajaToken(config: DarajaConfig = loadConfig()): Promise<string> {
  const usableUntil = new Date(Date.now() + EXPIRY_MARGIN_MS);

  const [cached] = await db()
    .select()
    .from(mpesaAuthTokens)
    .where(
      and(
        eq(mpesaAuthTokens.environment, config.environment),
        gt(mpesaAuthTokens.expiresAt, usableUntil),
      ),
    )
    .orderBy(desc(mpesaAuthTokens.expiresAt))
    .limit(1);

  if (cached) return cached.accessToken;

  const { accessToken, expiresAt } = await fetchAccessToken(config);

  await db().insert(mpesaAuthTokens).values({
    accessToken,
    expiresAt,
    environment: config.environment,
  });

  // Cheap opportunistic prune — only runs on a cache miss, i.e. hourly.
  await db().delete(mpesaAuthTokens).where(lt(mpesaAuthTokens.expiresAt, new Date()));

  return accessToken;
}

async function fetchAccessToken(
  config: DarajaConfig,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const url = `${baseUrl(config.environment)}/oauth/v1/generate?grant_type=client_credentials`;

  const res = await darajaFetch(
    url,
    { method: "GET", headers: { Authorization: `Basic ${credentials}` } },
    config.timeoutMs,
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Daraja token request failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  const body = (await res.json()) as DarajaTokenResponse;
  if (!body.access_token) {
    throw new Error("Daraja token response contained no access_token");
  }

  // expires_in comes back as a string of seconds ("3599").
  const ttlSeconds = Number(body.expires_in);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 3_599_000;

  return { accessToken: body.access_token, expiresAt: new Date(Date.now() + ttlMs) };
}
