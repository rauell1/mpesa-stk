/**
 * One-off: register the C2B validation and confirmation URLs for the
 * shortcode in the environment.
 *
 * Run after the callback URLs change (new domain, new tunnel) — re-running is
 * harmless, it overwrites the registration.
 *
 *   npx tsx integrations/safaricharge/scripts/register-c2b-urls.ts
 *
 * Validation URLs need activating by Safaricom on production shortcodes; in
 * sandbox they take effect immediately.
 */

import { loadConfig } from "../src/mpesa/config.js";
import { registerC2BUrls } from "../src/mpesa/c2b.js";

async function main() {
  const config = loadConfig();
  console.log(`Registering C2B URLs for shortcode ${config.shortCode} (${config.environment})`);
  console.log(`  validation:   ${config.callbackBaseUrl}/api/webhooks/mpesa/c2b/validation`);
  console.log(`  confirmation: ${config.callbackBaseUrl}/api/webhooks/mpesa/c2b/confirmation`);

  const result = await registerC2BUrls(config);
  console.log(`Daraja: ${result.ResponseCode} ${result.ResponseDescription}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
