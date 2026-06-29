/**
 * Farnell / element14 product-page parser (spec §9.4.1) — a host-specific Strategy.
 *
 * Best-effort layout selectors with the shared structured-metadata fallback (§9.4.2).
 * Covers the Farnell family hosts (e.g. `uk.farnell.com`, `cpc.farnell.com`). Keep all
 * Farnell-specific selectors here so DOM drift is fixed in one place.
 */
import { makeSupplierParser } from './metadata';

export const farnellParser = makeSupplierParser({
  id: 'farnell',
  label: 'Farnell',
  hostPattern: /(^|\.)farnell\.[a-z.]+$/i,
  selectors: {
    mpn: ['[data-testid="long-order-code-mpn"]', '.prodDetailInfoBlock .mpn', '[itemprop="mpn"]'],
    manufacturer: ['[data-testid="manufacturer-name"]', '.brandBlock a', '[itemprop="brand"]'],
    description: ['h1.pl-prod-title', '[data-testid="short-description"]', 'h1[itemprop="name"]', 'h1'],
    price: ['[data-testid="pricing-unit-price"]', '.priceBlock .price', '.unitPrice'],
  },
});
