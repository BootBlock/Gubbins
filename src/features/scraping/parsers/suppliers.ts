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
 * Whether a scrape target is one the extension is permitted to fetch (spec §9 hardening):
 * an absolute **https** URL whose host is — or is a subdomain of — a registered supplier
 * domain. This is the privileged background worker's own gate, applied *before* it makes a
 * network request, so a page that drives the bridge can never coerce it into fetching an
 * arbitrary origin (defence-in-depth above the manifest's `host_permissions`, which the
 * background fetch otherwise relies on alone). `http:`, `file:`, `data:`, credentials in the
 * URL, and any non-supplier host are all rejected.
 */
export function isAllowedSupplierUrl(rawUrl: string): boolean {
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
  return ALLOWED_SUPPLIER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
