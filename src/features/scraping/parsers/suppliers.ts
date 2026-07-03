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

/**
 * The registrable supplier domains the allowlist covers, derived from
 * {@link EXTENSION_HOST_PERMISSIONS} so the two can never drift. Each MV3 match pattern
 * `https://*.<domain>/*` becomes the bare `<domain>`; the leading `*.` matches the apex
 * and any subdomain (mirroring MV3 semantics).
 */
const ALLOWED_SUPPLIER_DOMAINS: readonly string[] = EXTENSION_HOST_PERMISSIONS.map((pattern) =>
  pattern
    .replace(/^https:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .toLowerCase(),
);

/**
 * Shared host-allowlist gate (spec §9 hardening): an absolute **https** URL, no userinfo,
 * whose host is — or is a subdomain of — one of `domains`. This is the privileged background
 * worker's own check, applied *before* it makes a network request, so a page that drives the
 * bridge can never coerce it into fetching an arbitrary origin (defence-in-depth above the
 * manifest's `host_permissions`). `http:`, `file:`, `data:`, credentials in the URL, and any
 * off-list host are all rejected.
 */
function isAllowedUrlForDomains(rawUrl: string, domains: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // A userinfo component (user:pass@host) is never legitimate here and can disguise the host.
  if (url.username.length > 0 || url.password.length > 0) return false;
  const host = url.hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Whether a scrape target is a registered supplier domain the extension may fetch (§9). */
export function isAllowedSupplierUrl(rawUrl: string): boolean {
  return isAllowedUrlForDomains(rawUrl, ALLOWED_SUPPLIER_DOMAINS);
}

/**
 * Host allowlist for the keyless **product-lookup** provider (recommendation point 2).
 * Open Food Facts is a free, open, key-less product database (`world.openfoodfacts.org`);
 * its coverage is groceries/consumables, but it needs no API key or secret — the only
 * lookup source compatible with this public, backend-less repo. Kept separate from the
 * supplier list because a product database is *not* a supplier: {@link isAllowedLookupUrl}
 * gates the barcode-lookup fetch, {@link isAllowedSupplierUrl} the URL scrape.
 */
export const PRODUCT_LOOKUP_HOST_PERMISSIONS: readonly string[] = ['https://*.openfoodfacts.org/*'];

const ALLOWED_LOOKUP_DOMAINS: readonly string[] = PRODUCT_LOOKUP_HOST_PERMISSIONS.map((pattern) =>
  pattern
    .replace(/^https:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .toLowerCase(),
);

/** Whether a product-lookup target is an allowed open-database host the extension may fetch. */
export function isAllowedLookupUrl(rawUrl: string): boolean {
  return isAllowedUrlForDomains(rawUrl, ALLOWED_LOOKUP_DOMAINS);
}

/**
 * The full set of host patterns the extension manifest must grant — suppliers plus the
 * product-lookup provider. `host-permissions.test.ts` pins `extension/manifest.json` to
 * this, so neither list can drift from the manifest.
 */
export const ALL_EXTENSION_HOST_PERMISSIONS: readonly string[] = [
  ...EXTENSION_HOST_PERMISSIONS,
  ...PRODUCT_LOOKUP_HOST_PERMISSIONS,
];
