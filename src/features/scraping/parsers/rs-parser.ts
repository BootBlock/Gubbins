/**
 * RS (RS Components / rs-online) product-page parser (spec §9.4.1) — a host-specific
 * Strategy.
 *
 * Best-effort layout selectors with the shared structured-metadata fallback (§9.4.2).
 * Keep all RS-specific selectors here so DOM drift is fixed in one place.
 */
import { makeSupplierParser } from './metadata';

export const rsParser = makeSupplierParser({
  id: 'rs',
  label: 'RS',
  hostPattern: /(^|\.)rs-online\.[a-z.]+$/i,
  selectors: {
    mpn: ['[data-testid="mpn"]', '[data-testid="long-description-attribute-mpn"]', '[itemprop="mpn"]'],
    manufacturer: ['[data-testid="brand"]', '[data-testid="brand-logo"] img', '[itemprop="brand"]'],
    description: ['[data-testid="long-description"]', 'h1[itemprop="name"]', 'h1'],
    price: ['[data-testid="price-inc-vat"]', '[data-testid="unit-price"]', '.price'],
  },
});
