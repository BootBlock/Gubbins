/**
 * §9.4 Strategy-pattern parsers & DOM-drift resilience.
 *
 * Runs under happy-dom: each fixture HTML is parsed to a real Document, so the
 * parsers exercise genuine `querySelector` paths. The key guarantees: a clean page
 * yields a strict payload; structural drift yields an explicit DOM_DRIFT error (never
 * a partial result or NaN); host routing picks the right strategy.
 */
import { describe, expect, it } from 'vitest';
import { DomDriftError, parsePrice } from './types';
import { runParser, selectParser, SUPPLIER_PARSERS } from './registry';
import { genericMetaParser } from './generic-meta-parser';
import { digikeyParser } from './digikey-parser';
import { mouserParser } from './mouser-parser';
import { farnellParser } from './farnell-parser';
import { lcscParser } from './lcsc-parser';
import { rsParser } from './rs-parser';
import { adafruitParser } from './adafruit-parser';
import { sparkfunParser } from './sparkfun-parser';

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const metaPage = `<!doctype html><html><head>
  <meta name="gubbins:mpn" content="NE555P" />
  <meta name="gubbins:manufacturer" content="Texas Instruments" />
  <meta name="gubbins:description" content="Precision 555 timer IC" />
  <meta name="gubbins:price" content="0.42" />
  <meta name="gubbins:currency" content="GBP" />
  <meta property="og:url" content="https://supplier.test/p/NE555P" />
</head><body><h1>NE555P</h1></body></html>`;

describe('parsePrice (§9.4.2 — never NaN)', () => {
  it.each([
    ['£0.42', 'GBP', 0.42],
    ['$1,234.56', 'USD', 1234.56],
    ['€9.99', 'EUR', 9.99],
    ['0.42 GBP', 'GBP', 0.42],
    ['12.50', 'GBP', 12.5], // bare number → default currency
  ])('parses %s', (text, currency, value) => {
    expect(parsePrice(text)).toEqual({ currency, value });
  });

  it.each(['', '   ', 'POA', 'call for pricing', '£'])('throws on unparseable "%s"', (text) => {
    expect(() => parsePrice(text)).toThrow(DomDriftError);
  });

  it('rejects a negative price', () => {
    expect(() => parsePrice('-1.00')).toThrow(DomDriftError);
  });
});

describe('genericMetaParser', () => {
  it('extracts a strict payload from structured metadata', () => {
    const payload = genericMetaParser.parse(docOf(metaPage), 'https://supplier.test/p/NE555P');
    expect(payload).toEqual({
      mpn: 'NE555P',
      manufacturer: 'Texas Instruments',
      description: 'Precision 555 timer IC',
      distributor_url: 'https://supplier.test/p/NE555P',
      scraped_pricing: { currency: 'GBP', value: 0.42 },
    });
  });

  it('returns null pricing when no price metadata is present', () => {
    const html = metaPage.replace(/<meta name="gubbins:price"[^>]*>/, '');
    const payload = genericMetaParser.parse(docOf(html), 'https://supplier.test/p/NE555P');
    expect(payload.scraped_pricing).toBeNull();
  });

  it('throws DomDriftError when the MPN metadata is gone (drift)', () => {
    const html = metaPage.replace(/<meta name="gubbins:mpn"[^>]*>/, '');
    expect(() => genericMetaParser.parse(docOf(html), 'https://supplier.test/x')).toThrow(DomDriftError);
  });
});

describe('digikeyParser', () => {
  const dkPage = `<!doctype html><html><head>
    <link rel="canonical" href="https://www.digikey.co.uk/p/ne555p/123" />
  </head><body>
    <span data-testid="mfr-part-number">NE555P</span>
    <span data-testid="manufacturer-name">Texas Instruments</span>
    <h1 data-testid="product-description">555 Timer</h1>
    <span data-testid="unit-price">£0.42</span>
  </body></html>`;

  it('matches digikey hosts only', () => {
    expect(digikeyParser.matches('https://www.digikey.co.uk/p/x')).toBe(true);
    expect(digikeyParser.matches('https://www.mouser.com/p/x')).toBe(false);
  });

  it('parses the product layout', () => {
    const payload = digikeyParser.parse(docOf(dkPage), 'https://www.digikey.co.uk/p/ne555p/123');
    expect(payload.mpn).toBe('NE555P');
    expect(payload.manufacturer).toBe('Texas Instruments');
    expect(payload.scraped_pricing).toEqual({ currency: 'GBP', value: 0.42 });
    expect(payload.distributor_url).toBe('https://www.digikey.co.uk/p/ne555p/123');
  });

  it('drifts loudly when the MPN node moves', () => {
    const drifted = dkPage.replace('data-testid="mfr-part-number"', 'data-testid="moved"');
    expect(() => digikeyParser.parse(docOf(drifted), 'https://www.digikey.co.uk/x')).toThrow(DomDriftError);
  });
});

describe('host-specific supplier parsers (§9.4.1 Strategy)', () => {
  it.each([
    [mouserParser, 'https://www.mouser.co.uk/ProductDetail/x', 'https://www.adafruit.com/product/1'],
    [farnellParser, 'https://uk.farnell.com/p/x', 'https://www.digikey.com/p/x'],
    [lcscParser, 'https://www.lcsc.com/product-detail/x.html', 'https://www.mouser.com/p/x'],
    [rsParser, 'https://uk.rs-online.com/web/p/x', 'https://www.lcsc.com/p/x'],
    [adafruitParser, 'https://www.adafruit.com/product/3', 'https://www.sparkfun.com/products/1'],
    [sparkfunParser, 'https://www.sparkfun.com/products/12002', 'https://uk.rs-online.com/p/x'],
  ])('$label matches only its own host', (parser, own, foreign) => {
    expect(parser.matches(own)).toBe(true);
    expect(parser.matches(foreign)).toBe(false);
  });

  it('prefers a host CSS selector over metadata, falling back per-field on drift', () => {
    // MPN via Mouser's host selector; manufacturer absent in markup → metadata fallback.
    const html = `<!doctype html><html><head>
      <meta name="gubbins:manufacturer" content="Texas Instruments" />
      <link rel="canonical" href="https://www.mouser.co.uk/ProductDetail/NE555P" />
    </head><body>
      <span id="pdpPartNumber">NE555P</span>
      <span data-testid="pdp-unit-price">£0.42</span>
    </body></html>`;
    const payload = mouserParser.parse(docOf(html), 'https://www.mouser.co.uk/ProductDetail/NE555P');
    expect(payload.mpn).toBe('NE555P'); // host selector
    expect(payload.manufacturer).toBe('Texas Instruments'); // metadata fallback
    expect(payload.scraped_pricing).toEqual({ currency: 'GBP', value: 0.42 });
    expect(payload.distributor_url).toBe('https://www.mouser.co.uk/ProductDetail/NE555P');
  });

  it('recovers the MPN from structured metadata when host selectors all miss', () => {
    const payload = lcscParser.parse(docOf(metaPage), 'https://www.lcsc.com/product-detail/x.html');
    expect(payload.mpn).toBe('NE555P');
  });

  it('throws DomDriftError when neither host selectors nor metadata yield an MPN', () => {
    const html = `<!doctype html><html><head>
      <link rel="canonical" href="https://uk.farnell.com/p/x" />
    </head><body><h1>Some heading</h1></body></html>`;
    expect(() => farnellParser.parse(docOf(html), 'https://uk.farnell.com/p/x')).toThrow(DomDriftError);
  });
});

describe('registry — strategy selection & uniform outcome', () => {
  it('registers every supported supplier plus the generic fallback last', () => {
    expect(SUPPLIER_PARSERS.map((p) => p.id)).toEqual([
      'digikey',
      'mouser',
      'farnell',
      'lcsc',
      'rs',
      'adafruit',
      'sparkfun',
      'generic-meta',
    ]);
  });

  it('routes each supplier host to its own parser', () => {
    expect(selectParser('https://www.mouser.com/p/x')?.id).toBe('mouser');
    expect(selectParser('https://uk.farnell.com/p/x')?.id).toBe('farnell');
    expect(selectParser('https://www.lcsc.com/p/x')?.id).toBe('lcsc');
    expect(selectParser('https://uk.rs-online.com/p/x')?.id).toBe('rs');
    expect(selectParser('https://www.adafruit.com/product/1')?.id).toBe('adafruit');
    expect(selectParser('https://www.sparkfun.com/products/1')?.id).toBe('sparkfun');
  });

  it('routes a DigiKey URL to the host-specific parser', () => {
    expect(selectParser('https://www.digikey.com/p/x')?.id).toBe('digikey');
  });

  it('falls back to generic metadata for an unknown host', () => {
    expect(selectParser('https://supplier.test/p/x')?.id).toBe('generic-meta');
  });

  it('runParser yields ok:true with a payload on a clean page', () => {
    const outcome = runParser(docOf(metaPage), 'https://supplier.test/p/NE555P');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.payload.mpn).toBe('NE555P');
  });

  it('runParser marshals a DOM_DRIFT error instead of throwing', () => {
    const html = metaPage.replace(/<meta name="gubbins:mpn"[^>]*>/, '');
    const outcome = runParser(docOf(html), 'https://supplier.test/x');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.error_type).toBe('DOM_DRIFT');
      expect(outcome.error.domain).toBe('supplier.test');
    }
  });
});
