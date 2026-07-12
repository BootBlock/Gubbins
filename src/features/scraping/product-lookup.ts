/**
 * Keyless barcode → product enrichment (recommendation point 2) — the pure provider logic.
 *
 * Two callers perform the actual request; this module holds the *pure* half they share — how to
 * build the lookup URL and how to turn the fetched body into a {@link ProductLookupResultPayload},
 * so both are unit-tested without a browser. When the companion extension is present it performs
 * the request (exactly as with the §9 supplier scrape) and bridges a typed payload back; when it
 * isn't, the app queries Open Food Facts **directly** after the user opts in — see
 * {@link import('./product-lookup-online').lookupProductOnline} (issue #59). The Open Food Facts
 * origin is the only host the CSP `connect-src` allow-list adds for that direct path.
 *
 * **Provider: Open Food Facts.** A free, open, **key-less** product database — the only
 * source compatible with this public, secret-free, backend-less repo. Its coverage is
 * groceries/consumables (food, drink, cosmetics), so a lookup legitimately misses many
 * hardware/parts barcodes; that is reported as a `NOT_FOUND`, never a bad guess. The API
 * is `GET /api/v2/product/<barcode>.json`; a `status` of 1 (with a product) means found.
 */
import type { ProductLookupResultPayload } from './protocol';

/** The Open Food Facts read host (mirrors the extension host allowlist entry). */
export const OPEN_FOOD_FACTS_HOST = 'world.openfoodfacts.org';

/** The product fields requested — kept minimal so the response is small and predictable. */
const LOOKUP_FIELDS = 'code,product_name,brands,generic_name,quantity';

/**
 * Build the Open Food Facts v2 product-lookup URL for a GTIN. The barcode is
 * percent-encoded (it is only digits in practice, but never trust the caller) and the
 * response is scoped to {@link LOOKUP_FIELDS}. Always an `https://` URL on the allow-listed
 * host, so the extension's {@link import('./parsers/suppliers').isAllowedLookupUrl} gate accepts it.
 */
export function buildProductLookupUrl(gtin: string): string {
  return `https://${OPEN_FOOD_FACTS_HOST}/api/v2/product/${encodeURIComponent(gtin)}.json?fields=${LOOKUP_FIELDS}`;
}

/** The outcome of parsing an Open Food Facts response body. */
export type ProductLookupParse =
  | { readonly ok: true; readonly payload: ProductLookupResultPayload }
  | { readonly ok: false; readonly reason: string };

/** Trim to a non-empty string, or null. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Open Food Facts lists brands as a comma-separated string (`"Acme, Acme Foods"`); take the
 * first as the manufacturer, trimmed. Null when absent.
 */
function firstBrand(value: unknown): string | null {
  const raw = clean(value);
  if (raw === null) return null;
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Parse an Open Food Facts response body into a typed product payload, or an explanatory
 * failure. A barcode the database does not carry (`status` ≠ 1, no product, or no usable
 * name) is a clean "not found" — the caller marshals it as a `NOT_FOUND`. Never throws:
 * malformed JSON is reported as a reason, not an exception.
 */
export function parseOpenFoodFactsProduct(body: string, gtin: string): ProductLookupParse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'The product database returned an unreadable response.' };
  }
  if (typeof json !== 'object' || json === null) {
    return { ok: false, reason: 'The product database returned an unexpected response.' };
  }

  const root = json as Record<string, unknown>;
  const found = root.status === 1 || root.status === '1';
  const product =
    typeof root.product === 'object' && root.product !== null
      ? (root.product as Record<string, unknown>)
      : null;
  if (!found || product === null) {
    return { ok: false, reason: `No product found for barcode ${gtin}.` };
  }

  // Name is mandatory; fall back to the generic name. Without either there is nothing
  // useful to fill, so treat it as "not found" rather than returning a nameless product.
  const name = clean(product.product_name) ?? clean(product.generic_name);
  if (name === null) {
    return { ok: false, reason: `The database has no name for barcode ${gtin}.` };
  }

  const genericName = clean(product.generic_name);
  const quantity = clean(product.quantity);
  // Prefer the generic name (a fuller description) when it differs from the display name;
  // otherwise fall back to the net quantity so the description field isn't wasted.
  const description =
    genericName && genericName.toLowerCase() !== name.toLowerCase()
      ? genericName
      : quantity
        ? `Net quantity: ${quantity}`
        : null;

  return {
    ok: true,
    payload: {
      gtin,
      name,
      brand: firstBrand(product.brands),
      description,
      quantity,
    },
  };
}
