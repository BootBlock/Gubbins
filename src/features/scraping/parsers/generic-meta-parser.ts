/**
 * Generic structured-metadata parser (spec §9.4.1 Strategy pattern).
 *
 * The deterministic, supplier-agnostic strategy: it reads the structured product
 * metadata many distributor pages already expose — Open Graph (`og:*`), schema.org
 * microdata (`[itemprop]`), and a Gubbins convention (`meta[name="gubbins:mpn"]`) —
 * via the shared {@link readStructuredMetadata} rather than fragile per-vendor layout
 * selectors. This makes it the canonical demonstration of the uniform parser interface
 * and the deterministic target for the §8.5.5 smoke's fixture supplier page. It is the
 * lowest-priority fallback in the registry, so a host-specific parser is preferred when
 * one matches.
 */
import { type ScrapeResultPayload } from '../protocol';
import { readStructuredMetadata } from './metadata';
import { DomDriftError, parsePrice, requireAttr, type SupplierParser } from './types';

export const genericMetaParser: SupplierParser = {
  id: 'generic-meta',
  label: 'Structured metadata',

  // The fallback strategy claims any URL; the registry tries host-specific parsers first.
  matches() {
    return true;
  },

  parse(doc: Document): ScrapeResultPayload {
    const meta = readStructuredMetadata(doc);
    if (!meta.mpn) throw new DomDriftError('Missing MPN — no recognised product metadata.');

    // Price is optional structurally, but if a price element is present it MUST parse.
    const scraped_pricing = meta.priceText ? parsePrice(meta.priceText, meta.currency ?? 'GBP') : null;
    // When the metadata names an explicit currency code, trust it over symbol inference.
    if (scraped_pricing && meta.currency) scraped_pricing.currency = meta.currency;

    const distributor_url = meta.url ?? requireAttr(doc, 'link[rel="canonical"]', 'href', 'distributor URL');

    return {
      mpn: meta.mpn,
      manufacturer: meta.manufacturer ?? '',
      description: meta.description ?? '',
      distributor_url,
      scraped_pricing,
    };
  },
};
