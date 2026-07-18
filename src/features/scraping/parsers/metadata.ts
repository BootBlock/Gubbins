/**
 * Shared structured-metadata extraction + the per-supplier parser factory (spec §9.4.1).
 *
 * Most distributor product pages expose machine-readable product metadata — schema.org
 * **JSON-LD** (`<script type="application/ld+json">`), Open Graph (`og:*`), microdata
 * (`[itemprop]`/`product:*`) and the Gubbins convention (`meta[name="gubbins:*"]`).
 * {@link readStructuredMetadata} reads all of that once, and the {@link makeSupplierParser}
 * factory layers a supplier's host-specific CSS selectors on top of it: host selectors win,
 * metadata is the resilient fallback. This keeps every supplier a discrete one-file Strategy
 * (§9.4.1 — no monolithic if/else) without copying the metadata-reading boilerplate into
 * each, and preserves §9.4.2 "no silent failures" (a missing MPN still throws
 * {@link DomDriftError} rather than guessing).
 *
 * ## Why JSON-LD carries the most weight
 *
 * Modern distributor front-ends are component frameworks with generated, hashed class names
 * — there is frequently *no* stable CSS hook to select (LCSC is the worked example: not one
 * semantic class, and no `[itemprop]` anywhere on the page). What those same pages do emit,
 * because search engines require it, is a schema.org `Product` block carrying `mpn`, `brand`,
 * `description` and `offers.price`/`offers.priceCurrency` as *typed fields*. That is both
 * more precise than the `og:*` tags (whose `description` is marketing copy) and far more
 * durable than any layout selector, so it is preferred over plain meta tags — behind only
 * the explicit `gubbins:*` convention, which exists precisely to let a page override.
 *
 * Pure (operates on a standard `Document`) so it is unit-tested under happy-dom and
 * bundled unchanged into the extension's content script.
 */
import { isUrlWithinDomains } from '../../../lib/host-match';
import { type ScrapeResultPayload } from '../protocol';
import { DomDriftError, optionalText, parsePrice, type SupplierParser } from './types';

/** First non-blank `content` attribute among the selectors, or null. */
export function metaContent(doc: ParentNode, selectors: readonly string[]): string | null {
  for (const sel of selectors) {
    const content = doc.querySelector(sel)?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return null;
}

/** The raw product fields a structured page exposes; any may be absent (null). */
export interface StructuredMetadata {
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly description: string | null;
  readonly priceText: string | null;
  readonly currency: string | null;
  readonly url: string | null;
}

/** A JSON value of unknown shape — page-supplied, so nothing may be assumed about it. */
type JsonValue = unknown;

/** Narrow to a plain object without asserting anything about its keys. */
function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON-LD `@type` may be a string or an array of strings; test both. */
function hasType(node: Record<string, JsonValue>, type: string): boolean {
  const raw = node['@type'];
  if (typeof raw === 'string') return raw.toLowerCase() === type;
  if (Array.isArray(raw)) return raw.some((t) => typeof t === 'string' && t.toLowerCase() === type);
  return false;
}

/**
 * Flatten a parsed JSON-LD document into every object node it contains. A page may ship a
 * bare object, a top-level array, or an `@graph` wrapper, and may nest the `Product` inside
 * another entity — so walk the whole structure rather than assuming one shape. Depth is
 * bounded because the input is untrusted page content and could be deeply nested or cyclic.
 */
function flattenNodes(value: JsonValue, out: Record<string, JsonValue>[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const entry of value) flattenNodes(entry, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  out.push(value);
  for (const entry of Object.values(value)) flattenNodes(entry, out, depth + 1);
}

/** Non-blank trimmed string, or null — JSON-LD fields are frequently empty strings. */
function cleanString(value: JsonValue): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  // `price` is legitimately numeric in schema.org; render it losslessly for parsePrice.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * schema.org models `brand` as either a bare string or an `Organization`/`Brand` object
 * with a `name`. Accept both rather than only the shape one supplier happens to emit.
 */
function readName(value: JsonValue): string | null {
  if (isRecord(value)) return cleanString(value['name']);
  return cleanString(value);
}

/** The first `Offer` carrying a usable price, from either a single offer or a list. */
function findOffer(offers: JsonValue): Record<string, JsonValue> | null {
  const nodes: Record<string, JsonValue>[] = [];
  flattenNodes(offers, nodes);
  return nodes.find((node) => cleanString(node['price']) !== null) ?? null;
}

/** Project one schema.org `Product` node onto the fields we care about. */
function productToMetadata(product: Record<string, JsonValue>): StructuredMetadata {
  const offer = findOffer(product['offers']);
  return {
    mpn: cleanString(product['mpn']) ?? cleanString(product['sku']),
    manufacturer: readName(product['brand']) ?? readName(product['manufacturer']),
    description: cleanString(product['description']),
    priceText: offer ? cleanString(offer['price']) : null,
    currency: offer ? cleanString(offer['priceCurrency']) : null,
    url: cleanString(product['url']) ?? (offer ? cleanString(offer['url']) : null),
  };
}

/**
 * Read the schema.org `Product` block a page exposes as JSON-LD, if any. Never throws:
 * page-supplied JSON is untrusted and routinely malformed, and a broken block must
 * degrade to the other metadata sources rather than fail the whole scrape (§9.4.2).
 *
 * A page may carry several `Product` nodes — a bare stub alongside the real listing, or a
 * "related products" carousel — so the first one found is not automatically the right one.
 * An identified product (one bearing an `mpn`/`sku`) is preferred over an anonymous stub;
 * only if no node is identified does the first `Product` stand, so a page that describes
 * itself loosely still yields its description and price.
 *
 * @internal Exported for unit tests only.
 */
export function readJsonLdProduct(doc: ParentNode): StructuredMetadata | null {
  const products: Record<string, JsonValue>[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue; // Malformed block — try the next one.
    }
    const nodes: Record<string, JsonValue>[] = [];
    flattenNodes(parsed, nodes);
    products.push(...nodes.filter((node) => hasType(node, 'product')));
  }
  if (products.length === 0) return null;

  const identified = products.find(
    (node) => cleanString(node['mpn']) !== null || cleanString(node['sku']) !== null,
  );
  return productToMetadata(identified ?? products[0]!);
}

/** First candidate that parses as an absolute URL, else null. */
export function firstValidUrl(candidates: readonly (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      return new URL(c).href;
    } catch {
      /* not absolute — skip */
    }
  }
  return null;
}

/**
 * Read whatever structured product metadata a page exposes (never throws).
 *
 * Per field the sources are tried in descending order of trustworthiness:
 * **`gubbins:*`** (an explicit, deliberate override) → **JSON-LD** (typed schema.org
 * fields — see the module doc for why this outranks the meta tags) → **plain meta tags**
 * (`itemprop`/`product:*`/`og:*`, best-effort and often marketing copy). Each source is
 * consulted independently per field, so a page that emits only a partial JSON-LD block
 * still picks the rest up from its meta tags.
 *
 * Note the `og:`-prefixed price/brand variants: the Open Graph product namespace is
 * inconsistently implemented in the wild — some pages emit `product:brand`, others
 * `og:product:brand` — so both spellings are accepted.
 */
export function readStructuredMetadata(doc: ParentNode): StructuredMetadata {
  const jsonLd = readJsonLdProduct(doc);

  const mpn =
    metaContent(doc, ['meta[name="gubbins:mpn"]']) ??
    jsonLd?.mpn ??
    metaContent(doc, ['meta[itemprop="mpn"]', 'meta[property="product:mfr_part_no"]']);
  const manufacturer =
    metaContent(doc, ['meta[name="gubbins:manufacturer"]']) ??
    jsonLd?.manufacturer ??
    metaContent(doc, [
      'meta[itemprop="brand"]',
      'meta[property="product:brand"]',
      'meta[property="og:product:brand"]',
    ]);
  const description =
    metaContent(doc, ['meta[name="gubbins:description"]']) ??
    jsonLd?.description ??
    metaContent(doc, ['meta[name="description"]', 'meta[property="og:description"]']) ??
    optionalText(doc, ['h1']);
  const priceText =
    metaContent(doc, ['meta[name="gubbins:price"]']) ??
    jsonLd?.priceText ??
    metaContent(doc, [
      'meta[itemprop="price"]',
      'meta[property="product:price:amount"]',
      'meta[property="og:product:price"]',
    ]);
  const currency =
    metaContent(doc, ['meta[name="gubbins:currency"]']) ??
    jsonLd?.currency ??
    metaContent(doc, [
      'meta[itemprop="priceCurrency"]',
      'meta[property="product:price:currency"]',
      'meta[property="og:product:price:currency"]',
    ]);
  const url =
    metaContent(doc, ['meta[property="og:url"]']) ??
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() ??
    jsonLd?.url ??
    null;
  return { mpn, manufacturer, description, priceText, currency, url };
}

/** Declarative description of a host-specific supplier parser (one per file). */
export interface SupplierParserConfig {
  readonly id: string;
  readonly label: string;
  /**
   * The supplier's registrable domains (e.g. `['farnell.com']`, `['digikey.com',
   * 'digikey.co.uk']`) — the apex and any subdomain match. A curated list rather than a
   * keyword pattern, so a look-alike domain that merely contains the supplier's name
   * (`lcsc.evil.com`) can never be routed to its parser.
   *
   * Each list mirrors the domains the extension is actually allowed to fetch
   * (`EXTENSION_HOST_PERMISSIONS` in `suppliers.ts`) rather than guessing at every
   * country TLD a distributor might operate. The background-fetch path is unaffected by
   * that choice — the allow-list already refused an off-list host before this routing ran.
   * On the **active-tab** path (which has no allow-list gate) a live tab on an off-list TLD
   * now falls through to the generic structured-metadata parser instead of the supplier's
   * own selectors; with JSON-LD support that fallback reads the same typed schema.org
   * fields, so it is a better outcome than country-site selectors that were never verified.
   * Add a TLD here once it is confirmed to exist and is added to the allow-list.
   */
  readonly domains: readonly string[];
  /**
   * Host-specific CSS selectors, tried before the structured-metadata fallback. Optional
   * in full: a supplier whose pages carry no stable CSS hook — only generated, hashed
   * class names — is better served by structured metadata alone than by selectors that
   * merely *look* precise while matching nothing (see `lcsc-parser.ts`).
   */
  readonly selectors?: {
    readonly mpn?: readonly string[];
    readonly manufacturer?: readonly string[];
    readonly description?: readonly string[];
    readonly price?: readonly string[];
  };
}

/**
 * Build a {@link SupplierParser} from a host's selector config. Host selectors take
 * priority; {@link readStructuredMetadata} is the fallback for any field they miss, so
 * a layout tweak that moves one selector degrades gracefully to metadata rather than
 * failing the whole scrape. A genuinely absent MPN — the one field with no sane default
 * — throws {@link DomDriftError} (§9.4.2: never guess, never emit a partial payload).
 */
export function makeSupplierParser(config: SupplierParserConfig): SupplierParser {
  const { id, label, domains, selectors } = config;
  return {
    id,
    label,
    matches(url: string): boolean {
      return isUrlWithinDomains(url, domains);
    },
    parse(doc: Document, url: string): ScrapeResultPayload {
      const meta = readStructuredMetadata(doc);

      const mpn = (selectors?.mpn ? optionalText(doc, selectors.mpn) : null) ?? meta.mpn;
      if (!mpn) {
        throw new DomDriftError(`${label}: MPN not found — host selectors and product metadata both empty.`);
      }

      const manufacturer =
        (selectors?.manufacturer ? optionalText(doc, selectors.manufacturer) : null) ??
        meta.manufacturer ??
        '';
      const description =
        (selectors?.description ? optionalText(doc, selectors.description) : null) ?? meta.description ?? '';

      const priceText = (selectors?.price ? optionalText(doc, selectors.price) : null) ?? meta.priceText;
      const scraped_pricing = priceText ? parsePrice(priceText, meta.currency ?? 'GBP') : null;
      // An explicit currency code from metadata beats symbol inference.
      if (scraped_pricing && meta.currency) scraped_pricing.currency = meta.currency;

      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim();
      const distributor_url = firstValidUrl([canonical, meta.url]) ?? url;

      return { mpn, manufacturer, description, distributor_url, scraped_pricing };
    },
  };
}
