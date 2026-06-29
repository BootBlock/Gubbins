/**
 * Production host allowlist for the companion extension (spec §9, §4 hardening).
 *
 * The extension manifest must NOT ship `host_permissions: ["<all_urls>"]` in a release
 * build — that would let the background worker fetch any site. Instead it is narrowed to
 * exactly the supplier domains we have parsers for. This module is the single source of
 * truth for that allowlist; `host-permissions.test.ts` asserts `extension/manifest.json`
 * matches it (and no longer contains `<all_urls>`), so the manifest can never silently
 * drift back to a broad grant or fall out of step with the registered parsers.
 *
 * MV3 match patterns cannot wildcard a TLD, so each supplier lists its concrete domains.
 * Subdomains are covered by the leading `*.` (e.g. `uk.farnell.com`, `www.mouser.com`).
 */
export const EXTENSION_HOST_PERMISSIONS: readonly string[] = [
  // DigiKey
  'https://*.digikey.com/*',
  'https://*.digikey.co.uk/*',
  // Mouser
  'https://*.mouser.com/*',
  'https://*.mouser.co.uk/*',
  // Farnell / element14
  'https://*.farnell.com/*',
  // LCSC
  'https://*.lcsc.com/*',
  // RS (RS Components)
  'https://*.rs-online.com/*',
  // Adafruit
  'https://*.adafruit.com/*',
  // SparkFun
  'https://*.sparkfun.com/*',
];
