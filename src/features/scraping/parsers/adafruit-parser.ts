/**
 * Adafruit product-page parser (spec §9.4.1) — a host-specific Strategy.
 *
 * Best-effort layout selectors with the shared structured-metadata fallback (§9.4.2).
 * Hobbyist supplier coverage. Keep all Adafruit-specific selectors here so DOM drift
 * is fixed in one place.
 */
import { makeSupplierParser } from './metadata';

export const adafruitParser = makeSupplierParser({
  id: 'adafruit',
  label: 'Adafruit',
  hostPattern: /(^|\.)adafruit\.[a-z.]+$/i,
  selectors: {
    mpn: ['.product-id', '[itemprop="productID"]', '[itemprop="sku"]', '.mpn'],
    manufacturer: ['.product-vendor', '[itemprop="brand"]'],
    description: ['h1[itemprop="name"]', '.product-main h1', 'h1'],
    price: ['#prod-price .price', '[itemprop="price"]', '.product-price'],
  },
});
