/**
 * DigiKey product-page parser (spec §9.4.1) — a host-specific Strategy example.
 *
 * This demonstrates the per-supplier strategy with layout-coupled CSS selectors and
 * strict §9.4.2 drift handling (a moved selector throws {@link DomDriftError} rather
 * than guessing). Real distributor markup changes often, so the selectors here are
 * documented as best-effort and intentionally fall back to the shared structured
 * metadata where possible; the goal of this phase is a correct, resilient *protocol*,
 * not an indefinitely-maintained scraper. Keep selectors in this one file so DOM
 * drift is fixed in a single place.
 */
import { type ScrapeResultPayload } from '../protocol';
import { optionalText, parsePrice, requireText, type SupplierParser } from './types';

export const digikeyParser: SupplierParser = {
  id: 'digikey',
  label: 'DigiKey',

  matches(url: string): boolean {
    try {
      return /(^|\.)digikey\.[a-z.]+$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  parse(doc: Document, url: string): ScrapeResultPayload {
    const mpn = requireText(
      doc,
      ['[data-testid="mfr-part-number"]', 'meta[itemprop="mpn"]', '[itemprop="mpn"]'],
      'MPN',
    );
    const manufacturer =
      optionalText(doc, ['[data-testid="manufacturer-name"]', '[itemprop="brand"]']) ?? '';
    const description =
      optionalText(doc, ['[data-testid="product-description"]', 'h1[itemprop="name"]', 'h1']) ?? '';

    const priceText = optionalText(doc, ['[data-testid="unit-price"]', '[itemprop="price"]']);
    const scraped_pricing = priceText ? parsePrice(priceText) : null;

    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')?.trim();

    return { mpn, manufacturer, description, distributor_url: canonical || url, scraped_pricing };
  },
};
