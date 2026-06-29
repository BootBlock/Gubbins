/**
 * SparkFun product-page parser (spec §9.4.1) — a host-specific Strategy.
 *
 * Best-effort layout selectors with the shared structured-metadata fallback (§9.4.2).
 * Hobbyist supplier coverage. Keep all SparkFun-specific selectors here so DOM drift
 * is fixed in one place.
 */
import { makeSupplierParser } from './metadata';

export const sparkfunParser = makeSupplierParser({
  id: 'sparkfun',
  label: 'SparkFun',
  hostPattern: /(^|\.)sparkfun\.[a-z.]+$/i,
  selectors: {
    mpn: ['.product-id', '[itemprop="sku"]', '.sku', '.mpn'],
    manufacturer: ['.product-manufacturer', '[itemprop="brand"]'],
    description: ['h1.product-title', 'h1[itemprop="name"]', 'h1'],
    price: ['.price-current', '[itemprop="price"]', '.product-price'],
  },
});
