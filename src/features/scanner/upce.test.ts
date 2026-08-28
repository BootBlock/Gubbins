import { describe, expect, it } from 'vitest';
import { expandUpcE, looksLikeUpcE } from './upce';

describe('looksLikeUpcE', () => {
  it('accepts eight digits led by number system 0 or 1', () => {
    expect(looksLikeUpcE('04252614')).toBe(true);
    expect(looksLikeUpcE('14252611')).toBe(true);
  });

  it('rejects any other leading digit — no other number system is defined', () => {
    expect(looksLikeUpcE('24252614')).toBe(false);
    expect(looksLikeUpcE('96385074')).toBe(false);
  });

  it('rejects anything that is not exactly eight digits', () => {
    expect(looksLikeUpcE('0425261')).toBe(false);
    expect(looksLikeUpcE('042526140')).toBe(false);
    expect(looksLikeUpcE('0425261A')).toBe(false);
    expect(looksLikeUpcE('')).toBe(false);
  });
});

describe('expandUpcE — every branch of the zero-run table', () => {
  it('expands the canonical example from the symbology (last body digit 1)', () => {
    expect(expandUpcE('04252614')).toBe('042100005264');
  });

  it('expands last body digit 0/1/2 — d1 d2 d6 0000 d3 d4 d5', () => {
    expect(expandUpcE('01234505')).toBe('012000003455');
    expect(expandUpcE('04252614')).toBe('042100005264');
  });

  it('expands last body digit 3 — d1 d2 d3 00000 d4 d5', () => {
    expect(expandUpcE('08724132')).toBe('087200000412');
  });

  it('expands last body digit 4 — d1 d2 d3 d4 00000 d5', () => {
    expect(expandUpcE('05987340')).toBe('059870000030');
  });

  it('expands last body digit 5–9 — d1 d2 d3 d4 d5 0000 d6', () => {
    expect(expandUpcE('00000154')).toBe('000001000054');
    expect(expandUpcE('01123494')).toBe('011234000094');
  });

  it('carries the number system and the check digit across unchanged', () => {
    expect(expandUpcE('14252611')).toBe('142100005261');
  });

  it('always yields twelve digits', () => {
    for (const code of ['04252614', '08724132', '05987340', '00000154', '14252611']) {
      expect(expandUpcE(code)).toHaveLength(12);
    }
  });

  it('ignores surrounding whitespace', () => {
    expect(expandUpcE('  04252614 ')).toBe('042100005264');
  });

  it('returns null for anything not UPC-E-shaped, without judging the check digit', () => {
    expect(expandUpcE('96385074')).toBeNull();
    expect(expandUpcE('042100005264')).toBeNull();
    // Shape only: a wrong check digit still expands — validation is the caller's job.
    expect(expandUpcE('04252619')).toBe('042100005269');
  });
});
