import { describe, expect, it } from 'vitest';
import { compressUpcA, expandUpcE, looksLikeUpcE } from './upce';

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
    expect(expandUpcE('01234523')).toBe('012200003453');
  });

  it('expands last body digit 3 — d1 d2 d3 00000 d4 d5', () => {
    expect(expandUpcE('08734131')).toBe('087300000411');
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
    for (const code of ['04252614', '08734131', '05987340', '00000154', '14252611']) {
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

describe('compressUpcA — the inverse of expandUpcE', () => {
  it('recovers the UPC-E a UPC-A was expanded from', () => {
    expect(compressUpcA('042100005264')).toBe('04252614');
    expect(compressUpcA('012000003455')).toBe('01234505');
    expect(compressUpcA('087300000411')).toBe('08734131');
    expect(compressUpcA('059870000030')).toBe('05987340');
    expect(compressUpcA('011234000094')).toBe('01123494');
    expect(compressUpcA('142100005261')).toBe('14252611');
  });

  it('returns null for a UPC-A no UPC-E compresses to', () => {
    expect(compressUpcA('036000291452')).toBeNull(); // no zero run to squeeze out
    expect(compressUpcA('242100005264')).toBeNull(); // number system 2 — not UPC-E territory
    expect(compressUpcA('4006381333931')).toBeNull(); // not twelve digits
    expect(compressUpcA('04252614')).toBeNull();
  });

  it('round-trips every genuine UPC-E, and refuses the degenerate codes that would collide', () => {
    // The round-trip is what makes expansion safe to try on an arbitrary 8-digit code: without
    // it, `00000030` and `00000040` both expand to `000000000000` and one would overwrite the
    // other. Only one of them compresses back, so only one is ever treated as a UPC-E.
    expect(expandUpcE('00000030')).toBe('000000000000');
    expect(expandUpcE('00000040')).toBe('000000000000');
    expect(compressUpcA('000000000000')).toBe('00000000');

    for (const code of ['04252614', '14252611', '01234505', '08734131', '05987340', '01123494']) {
      expect(compressUpcA(expandUpcE(code)!)).toBe(code);
    }
  });
});

describe('compressUpcA is the encoder every printed UPC-E comes from', () => {
  /** The GTIN mod-10 check digit, computed here so the property test drives real codes. */
  const checkDigit = (eleven: string): string => {
    let sum = 0;
    for (let i = 0; i < eleven.length; i += 1) {
      sum += Number(eleven[i]) * ((eleven.length - i) % 2 === 1 ? 3 : 1);
    }
    return String((10 - (sum % 10)) % 10);
  };

  it('round-trips every UPC-A that any UPC-E expands to, across the whole space', () => {
    // The claim the round-trip guard in `gtin.ts` rests on. Expansion is not injective, so
    // `compressUpcA(expandUpcE(e)) === e` is false for about 9% of the 8-digit space — but the
    // codes it is false for are ones no encoder emits. What must hold, and is asserted here over
    // all two million bodies, is the other direction: the UPC-A an encoder's own output expands
    // to is the one it was compressed from. Take either function's branches out of order and
    // this goes red at once. Asserted in one go rather than per code, to keep it quick.
    const failures: string[] = [];
    for (const system of ['0', '1']) {
      for (let body = 0; body < 1_000_000 && failures.length < 5; body += 1) {
        const upcA = expandUpcE(`${system}${String(body).padStart(6, '0')}0`)!;
        const withCheck = `${upcA.slice(0, 11)}${checkDigit(upcA.slice(0, 11))}`;
        const encoded = compressUpcA(withCheck);
        if (encoded === null || expandUpcE(encoded) !== withCheck) {
          failures.push(`${withCheck} -> ${encoded} -> ${encoded === null ? '' : expandUpcE(encoded)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
