/**
 * Unit tests for the Amazon ASIN parsing seam. Pure logic — no DB, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  ASIN_RE,
  DEFAULT_AMAZON_MARKETPLACE,
  asinToUrl,
  marketplaceFromHost,
  normaliseAsin,
  isAmazonHost,
  parseAsin,
  findAsin,
} from './asin';

describe('normaliseAsin', () => {
  it('accepts a canonical 10-char ASIN and upper-cases it', () => {
    expect(normaliseAsin('b0f3xf5zkf')).toBe('B0F3XF5ZKF');
    expect(normaliseAsin('  B0F3XF5ZKF  ')).toBe('B0F3XF5ZKF');
  });

  it('accepts the numeric ISBN-10 form', () => {
    expect(normaliseAsin('0306406152')).toBe('0306406152');
  });

  it('rejects anything not exactly ten alphanumerics', () => {
    expect(normaliseAsin('B0F3XF5ZK')).toBeNull(); // 9 chars
    expect(normaliseAsin('B0F3XF5ZKFA')).toBeNull(); // 11 chars
    expect(normaliseAsin('B0F3-F5ZKF')).toBeNull(); // punctuation
    expect(normaliseAsin('')).toBeNull();
  });

  it('exposes an anchored ASIN_RE', () => {
    expect(ASIN_RE.test('B0F3XF5ZKF')).toBe(true);
    expect(ASIN_RE.test('xB0F3XF5ZKF')).toBe(false);
  });
});

describe('isAmazonHost', () => {
  it('matches apex and subdomains across marketplaces', () => {
    expect(isAmazonHost('amazon.com')).toBe(true);
    expect(isAmazonHost('www.amazon.co.uk')).toBe(true);
    expect(isAmazonHost('smile.amazon.de')).toBe(true);
    expect(isAmazonHost('amazon.co.jp')).toBe(true);
  });

  it('rejects look-alike and unrelated hosts', () => {
    expect(isAmazonHost('amazon.evil.com')).toBe(false);
    expect(isAmazonHost('notamazon.com')).toBe(false);
    expect(isAmazonHost('example.com')).toBe(false);
  });
});

describe('parseAsin', () => {
  it('returns a bare ASIN unchanged (normalised)', () => {
    expect(parseAsin('B0F3XF5ZKF')).toBe('B0F3XF5ZKF');
    expect(parseAsin('b0f3xf5zkf')).toBe('B0F3XF5ZKF');
  });

  it('extracts the ASIN from a /dp/ URL with query params', () => {
    expect(parseAsin('https://www.amazon.co.uk/dp/B0F3XF5ZKF?ref=ppx_yo2ov_dt_b_fed_asin_title&th=1')).toBe(
      'B0F3XF5ZKF',
    );
  });

  it('extracts from a title-slug /dp/ URL and from /gp/product/', () => {
    expect(parseAsin('https://www.amazon.com/Some-Product-Title/dp/B0F3XF5ZKF/ref=sr_1_1')).toBe(
      'B0F3XF5ZKF',
    );
    expect(parseAsin('https://www.amazon.de/gp/product/B0F3XF5ZKF')).toBe('B0F3XF5ZKF');
  });

  it('extracts from the mobile /gp/aw/d/ path and an ?asin= query fallback', () => {
    expect(parseAsin('https://www.amazon.co.uk/gp/aw/d/B0F3XF5ZKF')).toBe('B0F3XF5ZKF');
    expect(parseAsin('https://www.amazon.co.uk/gp/cart?asin=B0F3XF5ZKF')).toBe('B0F3XF5ZKF');
  });

  it('rejects a non-Amazon URL even if it contains an ASIN-shaped segment', () => {
    expect(parseAsin('https://example.com/dp/B0F3XF5ZKF')).toBeNull();
  });

  it('returns null for an Amazon URL with no ASIN, and for junk', () => {
    expect(parseAsin('https://www.amazon.co.uk/gp/help')).toBeNull();
    expect(parseAsin('not a url or asin')).toBeNull();
    expect(parseAsin('   ')).toBeNull();
  });
});

describe('marketplaceFromHost', () => {
  it('returns the marketplace TLD of an Amazon host', () => {
    expect(marketplaceFromHost('www.amazon.co.uk')).toBe('co.uk');
    expect(marketplaceFromHost('amazon.com')).toBe('com');
    expect(marketplaceFromHost('smile.amazon.de')).toBe('de');
    expect(marketplaceFromHost('amazon.com.au')).toBe('com.au');
  });

  it('prefers the longest suffix so a two-part ccTLD wins over its single label', () => {
    // `co.uk` must win — never the bare `uk` (which is not even a marketplace here).
    expect(marketplaceFromHost('www.amazon.co.uk')).toBe('co.uk');
  });

  it('returns null for a non-Amazon or look-alike host', () => {
    expect(marketplaceFromHost('example.com')).toBeNull();
    expect(marketplaceFromHost('amazon.evil.com')).toBeNull();
  });
});

describe('asinToUrl', () => {
  it('synthesises the canonical /dp/ URL for the given marketplace', () => {
    expect(asinToUrl('B0F3XF5ZKF', 'co.uk')).toBe('https://www.amazon.co.uk/dp/B0F3XF5ZKF');
    expect(asinToUrl('B0F3XF5ZKF', 'com')).toBe('https://www.amazon.com/dp/B0F3XF5ZKF');
  });

  it('normalises the ASIN and falls back to the default marketplace for an unknown TLD', () => {
    expect(asinToUrl('b0f3xf5zkf')).toBe(`https://www.amazon.${DEFAULT_AMAZON_MARKETPLACE}/dp/B0F3XF5ZKF`);
    expect(asinToUrl('B0F3XF5ZKF', 'invalid-tld')).toBe(
      `https://www.amazon.${DEFAULT_AMAZON_MARKETPLACE}/dp/B0F3XF5ZKF`,
    );
  });

  it('round-trips with parseAsin', () => {
    expect(parseAsin(asinToUrl('B0F3XF5ZKF', 'de'))).toBe('B0F3XF5ZKF');
  });
});

describe('findAsin', () => {
  it('finds a bare modern ASIN in a line and reports the matched text', () => {
    expect(findAsin('Widget gadget B0F3XF5ZKF 2 units')).toEqual({
      asin: 'B0F3XF5ZKF',
      matchedText: 'B0F3XF5ZKF',
    });
  });

  it('prefers an Amazon URL over a stray token, returning the URL substring', () => {
    const found = findAsin('Cable https://www.amazon.co.uk/dp/B0F3XF5ZKF?th=1 £9.99');
    expect(found?.asin).toBe('B0F3XF5ZKF');
    expect(found?.matchedText).toBe('https://www.amazon.co.uk/dp/B0F3XF5ZKF?th=1');
  });

  it('does not auto-detect the numeric ISBN-10 form from loose text', () => {
    // A bare 10-digit run on an invoice line must not be mistaken for an ASIN.
    expect(findAsin('Order reference 0306406152 total')).toBeNull();
  });

  it('returns null when there is no ASIN or Amazon URL', () => {
    expect(findAsin('Resistor 10k x50')).toBeNull();
  });
});
