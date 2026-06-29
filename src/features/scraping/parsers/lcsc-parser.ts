/**
 * LCSC product-page parser (spec §9.4.1) — a host-specific Strategy.
 *
 * Best-effort layout selectors with the shared structured-metadata fallback (§9.4.2).
 * Keep all LCSC-specific selectors here so DOM drift is fixed in one place.
 */
import { makeSupplierParser } from './metadata';

export const lcscParser = makeSupplierParser({
  id: 'lcsc',
  label: 'LCSC',
  hostPattern: /(^|\.)lcsc\.[a-z.]+$/i,
  selectors: {
    mpn: ['.product-mpn', '[data-testid="product-mpn"]', 'td.mpn', '[itemprop="mpn"]'],
    manufacturer: ['.product-brand a', '.brand-name', '[itemprop="brand"]'],
    description: ['.product-title', 'h1[itemprop="name"]', 'h1'],
    price: ['.product-price .price-current', '.price-current', '.product-price'],
  },
});
