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
import { readJsonLdProduct, readStructuredMetadata } from './metadata';

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

  it.each([
    [digikeyParser, 'https://www.digikey.evil.com/p/x'],
    [mouserParser, 'https://mouser.evil.com/p/x'],
    [farnellParser, 'https://farnell.com.evil.net/p/x'],
    [lcscParser, 'https://lcsc.evil.com/product-detail/x.html'],
    [rsParser, 'https://rs-online.evil.com/web/p/x'],
    [adafruitParser, 'https://adafruit.evil.com/product/1'],
    [sparkfunParser, 'https://sparkfun.evil.com/products/1'],
  ])('$label refuses a look-alike domain that merely contains its name', (parser, lookalike) => {
    expect(parser.matches(lookalike)).toBe(false);
  });
});

/**
 * LCSC ships no semantic CSS hooks and no microdata — only hashed class names plus a
 * schema.org JSON-LD block. This fixture mirrors the **structure** of a real product page
 * (the `og:product:*` spellings, the marketing-copy `<meta name="description">`, the absence
 * of any `[itemprop]`, the generated `h1` classes) with entirely invented product values, so
 * it pins the shape we actually parse without carrying a third party's catalogue data.
 */
const lcscPage = `<!doctype html><html><head>
  <link rel="canonical" href="https://www.lcsc.com/product-detail/C900001.html" />
  <meta property="og:url" content="https://www.lcsc.com/product-detail/C900001.html" />
  <meta name="description" content="EX9-4700UF by EXAMPLECO - In-stock components at LCSC. Price from $0.0904." />
  <meta property="og:description" content="EX9-4700UF by EXAMPLECO - In-stock components at LCSC. Price from $0.0904." />
  <meta property="og:product:brand" content="EXAMPLECO" />
  <meta property="og:product:price" content="0.0904" />
  <script type="application/ld+json">
    {"@context":"http://schema.org","@type":"Product","name":"EXAMPLECO EX9-4700UF",
     "sku":"C900001","mpn":"EX9-4700UF","brand":{"@type":"Brand","name":"EXAMPLECO"},
     "description":"4700uF 20% 35V Aluminium Electrolytic Capacitor",
     "category":"Capacitors/Aluminium Electrolytic Capacitors",
     "offers":{"@type":"Offer","url":"https://www.lcsc.com/product-detail/C900001.html",
       "priceCurrency":"USD","price":0.0904,"itemCondition":"http://schema.org/NewCondition"}}
  </script>
  <script type="application/ld+json">
    {"@context":"http://schema.org","@type":"BreadcrumbList","itemListElement":[]}
  </script>
</head><body>
  <h1 class="text-[20px] font-Bold-600 text-[#1C1F23] leading-[28px]">EXAMPLECO EX9-4700UF</h1>
</body></html>`;

describe('lcscParser (structured-metadata driven)', () => {
  const url = 'https://www.lcsc.com/product-detail/C900001.html';

  it('parses a real-shaped LCSC page with no host selectors at all', () => {
    expect(lcscParser.parse(docOf(lcscPage), url)).toEqual({
      mpn: 'EX9-4700UF',
      manufacturer: 'EXAMPLECO',
      description: '4700uF 20% 35V Aluminium Electrolytic Capacitor',
      distributor_url: url,
      scraped_pricing: { currency: 'USD', value: 0.0904 },
    });
  });

  it('records the price in USD, not the GBP default', () => {
    // LCSC exposes no currency <meta>; only offers.priceCurrency prevents a wrong-currency
    // price being written against the item.
    expect(lcscParser.parse(docOf(lcscPage), url).scraped_pricing?.currency).toBe('USD');
  });

  it('prefers the JSON-LD description over the marketing-copy meta description', () => {
    const { description } = lcscParser.parse(docOf(lcscPage), url);
    expect(description).toBe('4700uF 20% 35V Aluminium Electrolytic Capacitor');
    expect(description).not.toContain('In-stock components');
  });

  it('still drifts loudly when the JSON-LD block is gone and nothing replaces it', () => {
    const drifted = lcscPage.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
    // og:product:brand/price survive, but no source supplies an MPN — §9.4.2 forbids guessing.
    expect(() => lcscParser.parse(docOf(drifted), url)).toThrow(DomDriftError);
  });

  it('throws DomDriftError when neither host selectors nor metadata yield an MPN', () => {
    const html = `<!doctype html><html><head>
      <link rel="canonical" href="https://uk.farnell.com/p/x" />
    </head><body><h1>Some heading</h1></body></html>`;
    expect(() => farnellParser.parse(docOf(html), 'https://uk.farnell.com/p/x')).toThrow(DomDriftError);
  });
});

describe('structured metadata — JSON-LD (shared across every parser)', () => {
  const ldPage = (product: string) =>
    `<!doctype html><html><head><link rel="canonical" href="https://supplier.test/p/1" />
     <script type="application/ld+json">${product}</script></head><body></body></html>`;

  it('reads a bare Product object', () => {
    const meta = readStructuredMetadata(
      docOf(ldPage('{"@type":"Product","mpn":"NE555P","brand":"TI","description":"Timer"}')),
    );
    expect(meta).toMatchObject({ mpn: 'NE555P', manufacturer: 'TI', description: 'Timer' });
  });

  it('finds the Product inside an @graph wrapper', () => {
    const meta = readStructuredMetadata(
      docOf(ldPage('{"@graph":[{"@type":"WebPage"},{"@type":"Product","mpn":"NE555P"}]}')),
    );
    expect(meta.mpn).toBe('NE555P');
  });

  it('finds the Product in a top-level array and accepts an array @type', () => {
    const meta = readStructuredMetadata(docOf(ldPage('[{"@type":["Thing","Product"],"mpn":"NE555P"}]')));
    expect(meta.mpn).toBe('NE555P');
  });

  it('falls back to sku when mpn is absent', () => {
    const meta = readStructuredMetadata(docOf(ldPage('{"@type":"Product","sku":"C900001"}')));
    expect(meta.mpn).toBe('C900001');
  });

  it('accepts brand as an object or a bare string', () => {
    const asObject = readStructuredMetadata(
      docOf(ldPage('{"@type":"Product","mpn":"X","brand":{"@type":"Brand","name":"Acme"}}')),
    );
    const asString = readStructuredMetadata(docOf(ldPage('{"@type":"Product","mpn":"X","brand":"Acme"}')));
    expect(asObject.manufacturer).toBe('Acme');
    expect(asString.manufacturer).toBe('Acme');
  });

  it('renders a numeric price losslessly and keeps its currency', () => {
    const meta = readStructuredMetadata(
      docOf(ldPage('{"@type":"Product","mpn":"X","offers":{"price":0.0904,"priceCurrency":"USD"}}')),
    );
    expect(meta.priceText).toBe('0.0904');
    expect(meta.currency).toBe('USD');
  });

  it('picks the first priced entry from an offers array', () => {
    const meta = readStructuredMetadata(
      docOf(
        ldPage(
          '{"@type":"Product","mpn":"X","offers":[{"@type":"Offer"},{"price":"1.50","priceCurrency":"EUR"}]}',
        ),
      ),
    );
    expect(meta.priceText).toBe('1.50');
    expect(meta.currency).toBe('EUR');
  });

  it('prefers an identified Product over an anonymous stub earlier on the page', () => {
    // A "related products" carousel or a bare stub must not win over the real listing —
    // taking the first Product found would attribute the wrong MPN to the item.
    const meta = readStructuredMetadata(
      docOf(
        ldPage('[{"@type":"Product","name":"Related item"},{"@type":"Product","mpn":"NE555P","brand":"TI"}]'),
      ),
    );
    expect(meta.mpn).toBe('NE555P');
    expect(meta.manufacturer).toBe('TI');
  });

  it('still uses a lone anonymous Product when nothing is identified', () => {
    const meta = readStructuredMetadata(
      docOf(ldPage('{"@type":"Product","description":"A thing","offers":{"price":"2.00"}}')),
    );
    expect(meta.mpn).toBeNull();
    expect(meta.description).toBe('A thing');
    expect(meta.priceText).toBe('2.00');
  });

  it('reads a top-level product url as well as an offer url', () => {
    // Read the block directly: readStructuredMetadata prefers og:url/canonical over JSON-LD
    // for the distributor link, so the fixture's canonical would mask this.
    const fromProduct = readJsonLdProduct(
      docOf(ldPage('{"@type":"Product","mpn":"X","url":"https://supplier.test/p/from-product"}')),
    );
    const fromOffer = readJsonLdProduct(
      docOf(ldPage('{"@type":"Product","mpn":"X","offers":{"price":"1","url":"https://supplier.test/p/o"}}')),
    );
    expect(fromProduct?.url).toBe('https://supplier.test/p/from-product');
    expect(fromOffer?.url).toBe('https://supplier.test/p/o');
  });

  it('ignores a malformed block and still reads a later valid one', () => {
    const html = `<!doctype html><html><head><link rel="canonical" href="https://supplier.test/p/1" />
      <script type="application/ld+json">{ not json ]</script>
      <script type="application/ld+json">{"@type":"Product","mpn":"NE555P"}</script>
      </head><body></body></html>`;
    expect(readStructuredMetadata(docOf(html)).mpn).toBe('NE555P');
  });

  it('returns nulls rather than throwing when there is no JSON-LD at all', () => {
    const html = '<!doctype html><html><head></head><body></body></html>';
    expect(readJsonLdProduct(docOf(html))).toBeNull();
    expect(readStructuredMetadata(docOf(html)).mpn).toBeNull();
  });

  it('lets an explicit gubbins:* override outrank JSON-LD', () => {
    const html = `<!doctype html><html><head>
      <meta name="gubbins:mpn" content="OVERRIDE" />
      <script type="application/ld+json">{"@type":"Product","mpn":"FROM-LD"}</script>
      </head><body></body></html>`;
    expect(readStructuredMetadata(docOf(html)).mpn).toBe('OVERRIDE');
  });

  it('outranks the plain meta tags, which stay as the last resort', () => {
    const html = `<!doctype html><html><head>
      <meta property="product:mfr_part_no" content="FROM-META" />
      <script type="application/ld+json">{"@type":"Product","mpn":"FROM-LD"}</script>
      </head><body></body></html>`;
    expect(readStructuredMetadata(docOf(html)).mpn).toBe('FROM-LD');

    const metaOnly = `<!doctype html><html><head>
      <meta property="product:mfr_part_no" content="FROM-META" />
      </head><body></body></html>`;
    expect(readStructuredMetadata(docOf(metaOnly)).mpn).toBe('FROM-META');
  });

  it('reads the og:-prefixed product variants some pages emit instead', () => {
    const html = `<!doctype html><html><head>
      <meta property="og:product:brand" content="EXAMPLECO" />
      <meta property="og:product:price" content="0.0904" />
      </head><body></body></html>`;
    const meta = readStructuredMetadata(docOf(html));
    expect(meta.manufacturer).toBe('EXAMPLECO');
    expect(meta.priceText).toBe('0.0904');
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
      'amazon',
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
