/**
 * Shared structured-metadata extraction + the per-supplier parser factory (spec §9.4.1).
 *
 * Most distributor product pages expose machine-readable product metadata — Open Graph
 * (`og:*`), schema.org microdata (`[itemprop]`/`product:*`) and the Gubbins convention
 * (`meta[name="gubbins:*"]`). {@link readStructuredMetadata} reads that once, and the
 * {@link makeSupplierParser} factory layers a supplier's host-specific CSS selectors on
 * top of it: host selectors win, metadata is the resilient fallback. This keeps every
 * supplier a discrete one-file Strategy (§9.4.1 — no monolithic if/else) without copying
 * the metadata-reading boilerplate into each, and preserves §9.4.2 "no silent failures"
 * (a missing MPN still throws {@link DomDriftError} rather than guessing).
 *
 * Pure (operates on a standard `Document`) so it is unit-tested under happy-dom and
 * bundled unchanged into the extension's content script.
 */
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

/** Read whatever structured product metadata a page exposes (never throws). */
export function readStructuredMetadata(doc: ParentNode): StructuredMetadata {
  const mpn = metaContent(doc, [
    'meta[name="gubbins:mpn"]',
    'meta[itemprop="mpn"]',
    'meta[property="product:mfr_part_no"]',
  ]);
  const manufacturer = metaContent(doc, [
    'meta[name="gubbins:manufacturer"]',
    'meta[itemprop="brand"]',
    'meta[property="product:brand"]',
  ]);
  const description =
    metaContent(doc, [
      'meta[name="gubbins:description"]',
      'meta[name="description"]',
      'meta[property="og:description"]',
    ]) ?? optionalText(doc, ['h1']);
  const priceText = metaContent(doc, [
    'meta[name="gubbins:price"]',
    'meta[itemprop="price"]',
    'meta[property="product:price:amount"]',
  ]);
  const currency = metaContent(doc, [
    'meta[name="gubbins:currency"]',
    'meta[itemprop="priceCurrency"]',
    'meta[property="product:price:currency"]',
  ]);
  const url =
    metaContent(doc, ['meta[property="og:url"]']) ??
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim() ??
    null;
  return { mpn, manufacturer, description, priceText, currency, url };
}

/** Declarative description of a host-specific supplier parser (one per file). */
export interface SupplierParserConfig {
  readonly id: string;
  readonly label: string;
  /** Matched against `new URL(url).hostname`. */
  readonly hostPattern: RegExp;
  /** Host-specific CSS selectors, tried before the structured-metadata fallback. */
  readonly selectors: {
    readonly mpn: readonly string[];
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
  const { id, label, hostPattern, selectors } = config;
  return {
    id,
    label,
    matches(url: string): boolean {
      try {
        return hostPattern.test(new URL(url).hostname);
      } catch {
        return false;
      }
    },
    parse(doc: Document, url: string): ScrapeResultPayload {
      const meta = readStructuredMetadata(doc);

      const mpn = optionalText(doc, selectors.mpn) ?? meta.mpn;
      if (!mpn) {
        throw new DomDriftError(`${label}: MPN not found — host selectors and product metadata both empty.`);
      }

      const manufacturer =
        (selectors.manufacturer ? optionalText(doc, selectors.manufacturer) : null) ??
        meta.manufacturer ??
        '';
      const description =
        (selectors.description ? optionalText(doc, selectors.description) : null) ?? meta.description ?? '';

      const priceText = (selectors.price ? optionalText(doc, selectors.price) : null) ?? meta.priceText;
      const scraped_pricing = priceText ? parsePrice(priceText, meta.currency ?? 'GBP') : null;
      // An explicit currency code from metadata beats symbol inference.
      if (scraped_pricing && meta.currency) scraped_pricing.currency = meta.currency;

      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim();
      const distributor_url = firstValidUrl([canonical, meta.url]) ?? url;

      return { mpn, manufacturer, description, distributor_url, scraped_pricing };
    },
  };
}
