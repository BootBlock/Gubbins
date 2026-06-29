/**
 * Mouser Electronics product-page parser (spec §9.4.1) — a host-specific Strategy.
 *
 * Best-effort layout selectors with the shared structured-metadata fallback; a moved
 * MPN selector degrades to metadata, and a genuinely absent MPN throws a DomDriftError
 * (§9.4.2). Keep all Mouser-specific selectors in this one file so DOM drift is fixed
 * in a single place.
 */
import { makeSupplierParser } from './metadata';

export const mouserParser = makeSupplierParser({
  id: 'mouser',
  label: 'Mouser',
  hostPattern: /(^|\.)mouser\.[a-z.]+$/i,
  selectors: {
    mpn: ['#pdpPartNumber', '[data-testid="pdp-mfr-part-number"]', '.pdp-product-number', '[itemprop="mpn"]'],
    manufacturer: ['[data-testid="pdp-manufacturer-name"]', '.manufacturer-name', '[itemprop="manufacturer"]'],
    description: ['#pdpDescription', '.pdp-description', 'h1[itemprop="name"]', 'h1'],
    price: ['[data-testid="pdp-unit-price"]', '.pdp-price .unit-price', '.unit-price'],
  },
});
