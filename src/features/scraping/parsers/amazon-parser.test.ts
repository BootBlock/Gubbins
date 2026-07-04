/**
 * §9.4 Amazon active-tab parser (Path A2).
 *
 * Runs under happy-dom against **synthetic**, Amazon-shaped fixtures — never a real
 * listing (a real Amazon page carries personal/session data and must never enter this
 * public repo). Made-up ASINs (`B0TEST…`) and `example`-style titles/brands only. The
 * guarantees mirror the other §9.4 parsers: a clean page yields a strict payload; a page
 * with no derivable ASIN drifts loudly (§9.4.2); host routing selects this parser; and the
 * ASIN lands as the payload `mpn` (→ the Amazon supplier part's order code downstream).
 */
import { describe, expect, it } from 'vitest';
import { amazonParser } from './amazon-parser';
import { runParser, selectParser } from './registry';
import { DomDriftError } from './types';

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** A synthetic UK listing: title, "Visit the … Store" byline, a buy-box price. */
const ukListing = `<!doctype html><html><head>
  <meta property="og:title" content="Example Widget — 10 pack" />
</head><body>
  <span id="productTitle">Example Widget — 10 pack, blue</span>
  <a id="bylineInfo" href="/stores/AcmeTools">Visit the Acme Tools Store</a>
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-offscreen">£9.99</span></span>
  </div>
</body></html>`;

const UK_URL = 'https://www.amazon.co.uk/Example-Widget/dp/B0TEST0001/ref=sr_1_1?th=1';

describe('amazonParser.matches (host routing)', () => {
  it('matches Amazon marketplaces and their subdomains only', () => {
    expect(amazonParser.matches('https://www.amazon.co.uk/dp/B0TEST0001')).toBe(true);
    expect(amazonParser.matches('https://amazon.de/gp/product/B0TEST0001')).toBe(true);
    expect(amazonParser.matches('https://smile.amazon.com/dp/B0TEST0001')).toBe(true);
  });

  it('rejects look-alike and unrelated hosts', () => {
    expect(amazonParser.matches('https://amazon.evil.test/dp/B0TEST0001')).toBe(false);
    expect(amazonParser.matches('https://www.digikey.com/p/x')).toBe(false);
    expect(amazonParser.matches('not a url')).toBe(false);
  });
});

describe('amazonParser.parse (§9.2 payload)', () => {
  it('emits the ASIN as mpn, title as description, cleaned brand, buy-box price + canonical url', () => {
    const payload = amazonParser.parse(docOf(ukListing), UK_URL);
    expect(payload).toEqual({
      mpn: 'B0TEST0001',
      manufacturer: 'Acme Tools',
      description: 'Example Widget — 10 pack, blue',
      distributor_url: 'https://www.amazon.co.uk/dp/B0TEST0001',
      scraped_pricing: { currency: 'GBP', value: 9.99 },
    });
  });

  it('reads the ASIN from the hidden #ASIN input when the URL has none', () => {
    const html = `<!doctype html><html><body>
      <input type="hidden" id="ASIN" value="B0TEST0002" />
      <span id="productTitle">Example Gizmo</span>
    </body></html>`;
    // A non-product Amazon URL (no /dp/ segment) — the ASIN must come from the DOM.
    const payload = amazonParser.parse(docOf(html), 'https://www.amazon.co.uk/gp/aw/ol');
    expect(payload.mpn).toBe('B0TEST0002');
    expect(payload.distributor_url).toBe('https://www.amazon.co.uk/dp/B0TEST0002');
  });

  it('falls back to a data-asin attribute when neither URL nor #ASIN carry it', () => {
    const html = `<!doctype html><html><body>
      <div data-asin="B0TEST0003"><span id="productTitle">Example Doohickey</span></div>
    </body></html>`;
    const payload = amazonParser.parse(docOf(html), 'https://www.amazon.com/gp/help');
    expect(payload.mpn).toBe('B0TEST0003');
  });

  it('cleans a "Brand: X" details-row byline to the bare brand', () => {
    const html = `<!doctype html><html><body>
      <span id="productTitle">Example Thing</span>
      <a id="bylineInfo">Brand: Globex</a>
    </body></html>`;
    const payload = amazonParser.parse(docOf(html), UK_URL);
    expect(payload.manufacturer).toBe('Globex');
  });

  it('returns null pricing when the buy-box price is absent (never NaN)', () => {
    const html = ukListing.replace(/<div id="corePriceDisplay_desktop_feature_div">[\s\S]*?<\/div>/, '');
    const payload = amazonParser.parse(docOf(html), UK_URL);
    expect(payload.scraped_pricing).toBeNull();
  });

  it('infers USD on the .com marketplace and builds a .com canonical url', () => {
    const html = `<!doctype html><html><body>
      <span id="productTitle">Example Widget US</span>
      <span class="a-price"><span class="a-offscreen">$12.34</span></span>
    </body></html>`;
    const payload = amazonParser.parse(docOf(html), 'https://www.amazon.com/dp/B0TEST0004');
    expect(payload.scraped_pricing).toEqual({ currency: 'USD', value: 12.34 });
    expect(payload.distributor_url).toBe('https://www.amazon.com/dp/B0TEST0004');
  });

  it('drifts loudly when no ASIN can be derived from URL or DOM (§9.4.2)', () => {
    const html = `<!doctype html><html><body><span id="productTitle">No ASIN here</span></body></html>`;
    expect(() => amazonParser.parse(docOf(html), 'https://www.amazon.co.uk/gp/help')).toThrow(DomDriftError);
  });
});

describe('amazon via the registry', () => {
  it('selectParser routes an Amazon URL to the amazon parser', () => {
    expect(selectParser(UK_URL)?.id).toBe('amazon');
  });

  it('runParser yields ok:true with the ASIN as mpn on a clean live page', () => {
    const outcome = runParser(docOf(ukListing), UK_URL);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.payload.mpn).toBe('B0TEST0001');
  });
});
