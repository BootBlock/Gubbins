/**
 * Generic structured-metadata parser (spec §9.4.1 Strategy pattern).
 *
 * The deterministic, supplier-agnostic strategy: it reads the structured product
 * metadata many distributor pages already expose — Open Graph (`og:*`), schema.org
 * microdata (`[itemprop]`), and a Gubbins convention (`meta[name="gubbins:mpn"]`) —
 * rather than fragile per-vendor layout selectors. This makes it the canonical
 * demonstration of the uniform parser interface and the deterministic target for the
 * §8.5.5 smoke's fixture supplier page. It is the lowest-priority fallback in the
 * registry, so a host-specific parser is preferred when one matches.
 */
import { type ScrapeResultPayload } from '../protocol';
import {
  DomDriftError,
  optionalText,
  parsePrice,
  requireAttr,
  type SupplierParser,
} from './types';

function metaContent(doc: ParentNode, selectors: readonly string[]): string | null {
  for (const sel of selectors) {
    const content = doc.querySelector(sel)?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return null;
}

export const genericMetaParser: SupplierParser = {
  id: 'generic-meta',
  label: 'Structured metadata',

  // The fallback strategy claims any URL; the registry tries host-specific parsers first.
  matches() {
    return true;
  },

  parse(doc: Document): ScrapeResultPayload {
    const mpn = metaContent(doc, [
      'meta[name="gubbins:mpn"]',
      'meta[itemprop="mpn"]',
      'meta[property="product:mfr_part_no"]',
    ]);
    if (!mpn) throw new DomDriftError('Missing MPN — no recognised product metadata.');

    const manufacturer =
      metaContent(doc, [
        'meta[name="gubbins:manufacturer"]',
        'meta[itemprop="brand"]',
        'meta[property="product:brand"]',
      ]) ?? '';

    const description =
      metaContent(doc, ['meta[name="gubbins:description"]', 'meta[name="description"]', 'meta[property="og:description"]']) ??
      optionalText(doc, ['h1']) ??
      '';

    // Price is optional structurally, but if a price element is present it MUST parse.
    const priceText = metaContent(doc, [
      'meta[name="gubbins:price"]',
      'meta[itemprop="price"]',
      'meta[property="product:price:amount"]',
    ]);
    const currencyMeta = metaContent(doc, [
      'meta[name="gubbins:currency"]',
      'meta[itemprop="priceCurrency"]',
      'meta[property="product:price:currency"]',
    ]);
    const scraped_pricing = priceText ? parsePrice(priceText, currencyMeta ?? 'GBP') : null;
    // When the metadata names an explicit currency code, trust it over symbol inference.
    if (scraped_pricing && currencyMeta) scraped_pricing.currency = currencyMeta;

    const distributor_url =
      metaContent(doc, ['meta[property="og:url"]', 'link[rel="canonical"]']) ??
      requireAttr(doc, 'link[rel="canonical"]', 'href', 'distributor URL');

    return { mpn, manufacturer, description, distributor_url, scraped_pricing };
  },
};
