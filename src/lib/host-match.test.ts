/**
 * Registrable-domain host matching.
 *
 * The look-alike cases are the point of the module: a keyword-shaped pattern would happily
 * accept `lcsc.evil.com`, so those assertions are what stop the old behaviour returning.
 */
import { describe, expect, it } from 'vitest';
import { isHostWithinDomains, isUrlWithinDomains } from './host-match';

describe('isHostWithinDomains', () => {
  it.each([
    ['lcsc.com', true],
    ['www.lcsc.com', true],
    ['deep.sub.lcsc.com', true],
    ['LCSC.COM', true],
    ['www.lcsc.com.', true], // trailing root dot
  ])('accepts the real domain and its subdomains: %s', (host, expected) => {
    expect(isHostWithinDomains(host, ['lcsc.com'])).toBe(expected);
  });

  it.each([
    'lcsc.evil.com', // keyword as someone else's subdomain
    'lcsc.com.evil.net', // keyword as a prefix of another registrable domain
    'notlcsc.com', // keyword without a label boundary
    'lcsc.co', // different TLD
    'evil.com',
    '',
    '   ',
  ])('rejects the look-alike %s', (host) => {
    expect(isHostWithinDomains(host, ['lcsc.com'])).toBe(false);
  });

  it('matches against any domain in the list', () => {
    const domains = ['digikey.com', 'digikey.co.uk'];
    expect(isHostWithinDomains('www.digikey.co.uk', domains)).toBe(true);
    expect(isHostWithinDomains('www.digikey.com', domains)).toBe(true);
    expect(isHostWithinDomains('www.digikey.de', domains)).toBe(false);
  });

  it('never matches an empty domain list', () => {
    expect(isHostWithinDomains('lcsc.com', [])).toBe(false);
  });

  it('ignores blank entries rather than matching everything', () => {
    expect(isHostWithinDomains('evil.com', ['', '  '])).toBe(false);
  });
});

describe('isUrlWithinDomains', () => {
  it('matches on the URL host', () => {
    expect(isUrlWithinDomains('https://www.lcsc.com/product-detail/C1.html', ['lcsc.com'])).toBe(true);
  });

  it('is not fooled by the domain appearing in the path or query', () => {
    expect(isUrlWithinDomains('https://evil.com/www.lcsc.com/x', ['lcsc.com'])).toBe(false);
    expect(isUrlWithinDomains('https://evil.com/?u=lcsc.com', ['lcsc.com'])).toBe(false);
  });

  it('is not fooled by userinfo disguising the host', () => {
    expect(isUrlWithinDomains('https://www.lcsc.com@evil.com/x', ['lcsc.com'])).toBe(false);
  });

  it('returns false for an unparseable URL', () => {
    expect(isUrlWithinDomains('not a url', ['lcsc.com'])).toBe(false);
  });
});
