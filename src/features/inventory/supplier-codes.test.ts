/**
 * Unit tests for the multi-supplier order-code recognition seam. Pure logic — no DB, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { findSupplierCode } from './supplier-codes';

describe('findSupplierCode', () => {
  it('recognises a bare LCSC part number', () => {
    expect(findSupplierCode('100nF cap C7461236 x50')).toEqual({
      supplier: 'LCSC',
      code: 'C7461236',
      matchedText: 'C7461236',
    });
  });

  it('recognises an LCSC listing URL and prefers it over a stray bare token', () => {
    const found = findSupplierCode('Cap https://www.lcsc.com/product-detail/C7461236.html £0.02');
    expect(found).toEqual({
      supplier: 'LCSC',
      code: 'C7461236',
      matchedText: 'https://www.lcsc.com/product-detail/C7461236.html',
    });
  });

  it('recognises a bare DigiKey order code (the -ND suffix)', () => {
    expect(findSupplierCode('Resistor RMCF1206FT5K10CT-ND x10')).toEqual({
      supplier: 'DigiKey',
      code: 'RMCF1206FT5K10CT-ND',
      matchedText: 'RMCF1206FT5K10CT-ND',
    });
  });

  it('does not derive a DigiKey code from a product URL (not present there)', () => {
    expect(
      findSupplierCode('https://www.digikey.com/en/products/detail/stackpole/RMCF1206FT5K10/1759499'),
    ).toBeNull();
  });

  it('recognises an RS Components listing URL', () => {
    expect(
      findSupplierCode('Resistor https://uk.rs-online.com/web/p/through-hole-resistors/1742708'),
    ).toEqual({
      supplier: 'RS Components',
      code: '1742708',
      matchedText: 'https://uk.rs-online.com/web/p/through-hole-resistors/1742708',
    });
  });

  it('recognises a Farnell listing URL', () => {
    expect(
      findSupplierCode('https://uk.farnell.com/multicomp/cfr0s2je012kit/resistor-kit/dp/1170595'),
    ).toEqual({
      supplier: 'Farnell',
      code: '1170595',
      matchedText: 'https://uk.farnell.com/multicomp/cfr0s2je012kit/resistor-kit/dp/1170595',
    });
  });

  it('recognises an Adafruit listing URL', () => {
    expect(findSupplierCode('https://www.adafruit.com/product/4208')).toEqual({
      supplier: 'Adafruit',
      code: '4208',
      matchedText: 'https://www.adafruit.com/product/4208',
    });
  });

  it('does not source a code from a look-alike domain (the bare LCSC token inside it may still match)', () => {
    // The URL branch rejects `lcsc.evil.com` outright; the bare-token fallback then still
    // finds the LCSC-shaped `C7461236` substring on its own, matching only that token —
    // never the untrusted URL — exactly as `findAsin` behaves for a look-alike Amazon host.
    expect(findSupplierCode('https://lcsc.evil.com/product-detail/C7461236.html')).toEqual({
      supplier: 'LCSC',
      code: 'C7461236',
      matchedText: 'C7461236',
    });
  });

  it('does not recognise a Mouser or SparkFun URL (no reliable order code)', () => {
    expect(findSupplierCode('https://www.mouser.com/ProductDetail/YAGEO/RC0603JR-072K4L')).toBeNull();
    expect(findSupplierCode('https://www.sparkfun.com/sparkfun-inventors-kit-v4.html')).toBeNull();
  });

  it('returns null when there is no recognised supplier code', () => {
    expect(findSupplierCode('Resistor 10k x50')).toBeNull();
  });
});
