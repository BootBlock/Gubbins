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
import { isHostWithinDomains } from '../../../lib/host-match';

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
 * Why a URL failed a host-allowlist gate — the *reason*, not just a no (issue #667).
 *
 * The gate itself only needs a boolean, but whoever put the URL there needs to know which of
 * the four refusals applied: "that site has no scraper" and "that link isn't https" call for
 * completely different fixes, and collapsing them leaves a user with a refusal they cannot
 * act on. Kept beside the gate (rather than derived by a caller re-parsing the URL) so the
 * reason can never disagree with the decision.
 */
export type UrlRefusal =
  /** Not a parseable absolute URL at all (a bare order code, a typo, a relative path). */
  | 'MALFORMED'
  /** Parseable, but not `https:` — `http:`, `file:`, `data:`, … are never fetched. */
  | 'NOT_HTTPS'
  /** Carries `user:pass@` userinfo, which can disguise the real host. */
  | 'CREDENTIALS'
  /** A well-formed https URL whose host is simply not on the list. */
  | 'OFF_LIST';

/**
 * Short diagnostic per refusal, for the marshalled `reason` field of a §9.4.2 error.
 *
 * Deliberately *not* the user-facing copy — that belongs to the UI (which can name the
 * supported suppliers and translate); this is the developer-facing detail that rides the wire
 * beside the error type, in the same register as `Supplier blocked the request (HTTP 403).`
 */
export const URL_REFUSAL_REASONS: Record<UrlRefusal, string> = {
  MALFORMED: 'Not a valid absolute URL.',
  NOT_HTTPS: 'Only https URLs are fetched.',
  CREDENTIALS: 'URL carries embedded credentials.',
  OFF_LIST: 'Host is not on the allow-list.',
};

/**
 * Shared host-allowlist gate (spec §9 hardening): an absolute **https** URL, no userinfo,
 * whose host is — or is a subdomain of — one of `domains`. This is the privileged background
 * worker's own check, applied *before* it makes a network request, so a page that drives the
 * bridge can never coerce it into fetching an arbitrary origin (defence-in-depth above the
 * manifest's `host_permissions`). `http:`, `file:`, `data:`, credentials in the URL, and any
 * off-list host are all rejected.
 *
 * Returns the {@link UrlRefusal} that applied, or `null` when the URL may be fetched.
 */
function classifyUrlForDomains(rawUrl: string, domains: readonly string[]): UrlRefusal | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'MALFORMED';
  }
  if (url.protocol !== 'https:') return 'NOT_HTTPS';
  // A userinfo component (user:pass@host) is never legitimate here and can disguise the host.
  if (url.username.length > 0 || url.password.length > 0) return 'CREDENTIALS';
  return isHostWithinDomains(url.hostname, domains) ? null : 'OFF_LIST';
}

function isAllowedUrlForDomains(rawUrl: string, domains: readonly string[]): boolean {
  return classifyUrlForDomains(rawUrl, domains) === null;
}

/**
 * Why a scrape target cannot be fetched, or `null` when it can (§9).
 *
 * The app-side counterpart to {@link isAllowedSupplierUrl}: the same decision, but carrying the
 * reason so a URL box can explain itself *before* the round-trip instead of relaying a refusal
 * the app could have made itself (issue #667).
 */
export function classifySupplierUrl(rawUrl: string): UrlRefusal | null {
  return classifyUrlForDomains(rawUrl, ALLOWED_SUPPLIER_DOMAINS);
}

/** Whether a scrape target is a registered supplier domain the extension may fetch (§9). */
export function isAllowedSupplierUrl(rawUrl: string): boolean {
  return classifySupplierUrl(rawUrl) === null;
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
 * Host allowlist for the **category data-lookup** providers (issue #616) — the open databases a
 * category's fields can be filled from.
 *
 * Kept as a third list rather than folded into either above, because the three answer different
 * questions and gate different fetches: a *supplier* page is scraped for a part, a *barcode* is
 * resolved against a product database, and a *category* is filled from a subject database. One
 * combined list would let a URL cleared for one purpose be fetched for another.
 *
 * `*.wikidata.org` covers both hosts the `wikidata-film` provider reaches — `www.wikidata.org`
 * for entity search and `query.wikidata.org` for the SPARQL detail query — since the leading
 * `*.` matches the apex and any subdomain, mirroring MV3 semantics.
 */
export const DATA_LOOKUP_HOST_PERMISSIONS: readonly string[] = ['https://*.wikidata.org/*'];

const ALLOWED_DATA_LOOKUP_DOMAINS: readonly string[] = DATA_LOOKUP_HOST_PERMISSIONS.map((pattern) =>
  pattern
    .replace(/^https:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .toLowerCase(),
);

/** Whether a category data-lookup target is an allowed open-database host (issue #616). */
export function isAllowedDataLookupUrl(rawUrl: string): boolean {
  return isAllowedUrlForDomains(rawUrl, ALLOWED_DATA_LOOKUP_DOMAINS);
}

/**
 * The full set of host patterns the extension manifest must grant — suppliers, the
 * product-lookup provider, and the category data-lookup providers.
 * `host-permissions.test.ts` pins `extension/manifest.json` to this, so no list can drift
 * from the manifest.
 *
 * @internal Exported for unit tests only.
 */
export const ALL_EXTENSION_HOST_PERMISSIONS: readonly string[] = [
  ...EXTENSION_HOST_PERMISSIONS,
  ...PRODUCT_LOOKUP_HOST_PERMISSIONS,
  ...DATA_LOOKUP_HOST_PERMISSIONS,
];
