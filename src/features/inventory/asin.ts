/**
 * Amazon ASIN parsing helpers — a pure seam (see `docs/todo/amazon-import_2026-07-03.md`).
 *
 * An **ASIN** (Amazon Standard Identification Number) is a 10-character identifier
 * Amazon assigns to every listing. Modern product ASINs are `B0…` (a `B0` prefix plus
 * eight upper-case alphanumerics); older book-style ASINs are the numeric ISBN-10 form.
 * An ASIN maps 1:1 to a canonical listing URL — `https://www.amazon.<tld>/dp/<ASIN>` —
 * so "add from a listing URL", "add from a bare ASIN" and "add a line off an invoice"
 * all reduce to *turning an ASIN into an item field*. This module is that shared,
 * DOM-free, exhaustively-testable core; the line-list importer ({@link ../text-import})
 * uses {@link findAsin} to recognise an ASIN (or Amazon URL) inside a pasted line and
 * store it as the item's SKU/MPN.
 *
 * We deliberately treat Amazon as a **supplier** and the ASIN as its part/order code:
 * it is not a manufacturer part number, but the importer's single "SKU / MPN" slot is
 * where a distributor code lives today, so an ASIN recognised here fills that slot.
 */

/** A canonical ASIN: exactly 10 upper-case alphanumerics. */
export const ASIN_RE = /^[A-Z0-9]{10}$/;

/**
 * The distinctive **modern** ASIN form — `B0` followed by eight alphanumerics — used to
 * spot an ASIN inside arbitrary free text. Restricting the free-text scan to the `B0…`
 * shape (rather than any 10-char run) avoids the false positives a bare token would bring:
 * ordinary SKUs, model numbers and ISBN-10 digit runs on an invoice line. The numeric
 * ISBN-10 form is still accepted via an explicit URL or a `sku:` label, just never
 * auto-detected from loose text.
 */
const BARE_ASIN_RE = /\bB0[A-Z0-9]{8}\b/i;

/** An `http(s)` URL on an `amazon.*` host, matched loosely inside a larger string. */
const AMAZON_URL_RE = /https?:\/\/[^\s<>"']*amazon\.[^\s<>"']*/i;

/**
 * The default Amazon marketplace TLD used to synthesise a canonical listing URL when
 * none can be derived from context (e.g. a bare ASIN with no accompanying host). The
 * active-tab parser ({@link ../scraping/parsers/amazon-parser}) always derives the real
 * marketplace from the live page's host, so this default only covers the degenerate case.
 * Chosen as the primary UK marketplace, matching the app's `en-GB` locale default.
 */
export const DEFAULT_AMAZON_MARKETPLACE = 'co.uk';

/**
 * The marketplace TLDs Amazon operates under (single-label TLDs and the two-part ccTLD
 * suffixes). A curated set — rather than a loose `amazon.*` pattern — is what tells the
 * genuine registrable domain `amazon.co.uk` from a look-alike like `amazon.evil.com`,
 * where `amazon` is merely a subdomain of someone else's domain. Extend as needed.
 */
const AMAZON_TLDS: ReadonlySet<string> = new Set([
  'com',
  'co.uk',
  'de',
  'fr',
  'it',
  'es',
  'nl',
  'se',
  'pl',
  'com.be',
  'com.tr',
  'ca',
  'com.mx',
  'com.br',
  'com.au',
  'co.jp',
  'in',
  'sg',
  'ae',
  'sa',
  'eg',
  'cn',
]);

/**
 * The `/<segment>/<ASIN>` path shapes Amazon uses for a product: `/dp/`, `/gp/product/`,
 * the mobile `/gp/aw/d/`, `/product/`, and `/gp/offer-listing/`. A title slug may precede
 * the segment (`/Some-Title/dp/ASIN`), so the match is not anchored to the path start.
 */
const AMAZON_PATH_ASIN_RE =
  /\/(?:dp|gp\/product|gp\/aw\/d|product|gp\/offer-listing)\/([A-Z0-9]{10})(?:[/?]|$)/i;

/** Normalise a candidate to a canonical ASIN, or `null` when it is not one. */
export function normaliseAsin(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  return ASIN_RE.test(value) ? value : null;
}

/**
 * Whether a hostname is an Amazon marketplace host — the registrable domain
 * `amazon.<tld>` for a known marketplace TLD, at the apex or under any subdomain. A
 * look-alike where `amazon` is a subdomain of another domain (`amazon.evil.com`) is
 * rejected, because there `amazon.com` is neither the whole host nor a dot-suffix of it.
 */
export function isAmazonHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  for (const tld of AMAZON_TLDS) {
    const registrable = `amazon.${tld}`;
    if (h === registrable || h.endsWith(`.${registrable}`)) return true;
  }
  return false;
}

/**
 * Parse a single ASIN from user input that is *either* a bare ASIN (`B0F3XF5ZKF`) *or*
 * an Amazon listing URL (`https://www.amazon.co.uk/dp/B0F3XF5ZKF?ref=…`). Returns the
 * canonical 10-char ASIN, or `null` when the input is neither. A URL must be on an
 * Amazon host; the ASIN is read from a known product path segment, then from an `asin`
 * query parameter as a fallback.
 */
export function parseAsin(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // A bare ASIN token (accepts the ISBN-10 numeric form too, since it is explicit here).
  const bare = normaliseAsin(trimmed);
  if (bare) return bare;

  // Otherwise it must be a parseable Amazon URL.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!isAmazonHost(url.hostname)) return null;

  const path = AMAZON_PATH_ASIN_RE.exec(url.pathname);
  if (path) {
    const asin = normaliseAsin(path[1]!);
    if (asin) return asin;
  }
  const query = url.searchParams.get('asin');
  return query ? normaliseAsin(query) : null;
}

/**
 * The Amazon marketplace TLD of a host — `www.amazon.co.uk` → `co.uk`, `amazon.de` → `de` —
 * or `null` when the host is not an Amazon marketplace. Preferring the longest matching
 * suffix disambiguates the two-part ccTLDs (`co.uk`, `com.au`) from their single-label
 * cousins. Used to carry the *live tab's* marketplace into a synthesised canonical URL so
 * the enriched item links back to the same locale/currency the user was viewing.
 */
export function marketplaceFromHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  let best: string | null = null;
  for (const tld of AMAZON_TLDS) {
    const registrable = `amazon.${tld}`;
    if ((h === registrable || h.endsWith(`.${registrable}`)) && (best === null || tld.length > best.length)) {
      best = tld;
    }
  }
  return best;
}

/**
 * Synthesise the canonical Amazon listing URL for an ASIN on a given marketplace —
 * `https://www.amazon.<tld>/dp/<ASIN>`. An ASIN maps 1:1 to this stable link, so it is
 * the durable `distributor_url` a scrape or a bare-ASIN add records. `marketplace` is a
 * TLD suffix (`co.uk`, `com`, …); an unrecognised one falls back to
 * {@link DEFAULT_AMAZON_MARKETPLACE} so the result is always a well-formed URL. The ASIN
 * is normalised (upper-cased/trimmed); callers should pass one already validated by
 * {@link normaliseAsin} / {@link parseAsin}.
 */
export function asinToUrl(asin: string, marketplace: string = DEFAULT_AMAZON_MARKETPLACE): string {
  const canonical = normaliseAsin(asin) ?? asin.trim().toUpperCase();
  const tld = AMAZON_TLDS.has(marketplace) ? marketplace : DEFAULT_AMAZON_MARKETPLACE;
  return `https://www.amazon.${tld}/dp/${canonical}`;
}

/**
 * Find the first ASIN inside a block of free text (typically one invoice / paste line),
 * returning the canonical ASIN together with the exact substring it was found in so the
 * caller can strip it from the remaining text. An **Amazon URL** takes precedence over a
 * bare token (a URL that also contains a stray `B0…`-looking id must resolve to its real
 * product ASIN); failing that, a bare modern `B0…` token is matched. Returns `null` when
 * neither is present.
 */
export function findAsin(text: string): { asin: string; matchedText: string } | null {
  const url = AMAZON_URL_RE.exec(text);
  if (url) {
    const asin = parseAsin(url[0]);
    if (asin) return { asin, matchedText: url[0] };
  }
  const bare = BARE_ASIN_RE.exec(text);
  if (bare) return { asin: bare[0].toUpperCase(), matchedText: bare[0] };
  return null;
}
