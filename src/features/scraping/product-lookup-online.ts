/**
 * Direct (extension-less) barcode → product lookup for the PWA (issue #59).
 *
 * Historically a barcode lookup could only run through the privileged companion extension, so on
 * a phone — where there is no extension — the "Look up product" affordance never appeared and the
 * feature felt missing. This module lets the app query the open, key-less **Open Food Facts**
 * database *directly* instead, reusing the same pure {@link buildProductLookupUrl} /
 * {@link parseOpenFoodFactsProduct} the extension path uses, so both resolve a barcode identically.
 *
 * Crossing to the network is **opt-in and consented** — the caller only invokes this after the
 * user agrees (a one-time prompt, remembered via the `allowOnlineProductLookup` preference), and
 * the Open Food Facts origin is the single host added to the CSP `connect-src` allow-list for it.
 * `fetchImpl` is injectable so the round-trip is unit-testable without a real network.
 */
import { buildProductLookupUrl, parseOpenFoodFactsProduct, type ProductLookupParse } from './product-lookup';

/**
 * Look a GTIN up against Open Food Facts and parse the response into a typed product (or an
 * explanatory failure). Never throws: a network error or non-OK status is returned as a
 * `{ ok: false, reason }`, exactly like a parse miss, so the caller has one shape to handle.
 */
export async function lookupProductOnline(
  gtin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductLookupParse> {
  let response: Response;
  try {
    response = await fetchImpl(buildProductLookupUrl(gtin), { headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, reason: 'Couldn’t reach the product database. Check your connection and try again.' };
  }
  // Open Food Facts v2 answers a barcode it doesn't carry with HTTP 404 (and a `{ status: 0 }`
  // body) — a legitimate "no product for this barcode", not a failure. Read that body through the
  // shared parser so the user sees a clean "no product found" message rather than a raw error code
  // (issue #439). Any *other* non-OK status is a genuine fault worth surfacing.
  if (!response.ok && response.status !== 404) {
    return { ok: false, reason: `The product database returned an error (${response.status}).` };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: 'The product database returned an unreadable response.' };
  }
  return parseOpenFoodFactsProduct(body, gtin);
}
