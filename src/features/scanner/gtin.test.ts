import { describe, expect, it } from 'vitest';
import { describeGtinConcern, hasValidGtinCheckDigit, isValidGtin, parseGtin } from './gtin';

describe('GTIN check digit', () => {
  it('accepts known-valid codes across every width', () => {
    expect(hasValidGtinCheckDigit('96385074')).toBe(true); // EAN-8
    expect(hasValidGtinCheckDigit('036000291452')).toBe(true); // UPC-A (12)
    expect(hasValidGtinCheckDigit('4006381333931')).toBe(true); // EAN-13
    expect(hasValidGtinCheckDigit('00012345678905')).toBe(true); // GTIN-14
  });

  it('rejects a code with a wrong check digit', () => {
    expect(hasValidGtinCheckDigit('4006381333930')).toBe(false);
    expect(hasValidGtinCheckDigit('036000291451')).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(hasValidGtinCheckDigit('40063813339A1')).toBe(false);
    expect(hasValidGtinCheckDigit('')).toBe(false);
  });
});

describe('isValidGtin', () => {
  it('requires a recognised length', () => {
    // A run of digits with a correct-looking length but wrong count is not a GTIN.
    expect(isValidGtin('12345')).toBe(false); // 5 digits — no such GTIN width
    expect(isValidGtin('4006381333931')).toBe(true); // 13
  });

  it('ignores surrounding whitespace', () => {
    expect(isValidGtin('  4006381333931  ')).toBe(true);
  });

  it('rejects a UUID and other non-numeric strings (never collides with a Gubbins code)', () => {
    expect(isValidGtin('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isValidGtin('gubbins:item:550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });
});

describe('parseGtin', () => {
  it('returns the trimmed digits verbatim (no zero-padding)', () => {
    expect(parseGtin('  036000291452 ')).toBe('036000291452');
    expect(parseGtin('96385074')).toBe('96385074');
  });

  it('returns null for a non-GTIN', () => {
    expect(parseGtin('not-a-code')).toBeNull();
    expect(parseGtin('4006381333930')).toBeNull(); // bad check digit
  });
});

describe('describeGtinConcern — judging a hand-typed entry (issue #344)', () => {
  it('stays quiet for a blank field', () => {
    expect(describeGtinConcern('')).toBeNull();
    expect(describeGtinConcern('   ')).toBeNull();
  });

  it('stays quiet for a valid GTIN of any width, whitespace and all', () => {
    expect(describeGtinConcern('96385074')).toBeNull();
    expect(describeGtinConcern('036000291452')).toBeNull();
    expect(describeGtinConcern('  4006381333931  ')).toBeNull();
    expect(describeGtinConcern('00012345678905')).toBeNull();
  });

  it('flags a transposed digit — the exact silent-corruption case', () => {
    // …930 for …931: saved verbatim today, and then never resolves on a re-scan.
    expect(describeGtinConcern('4006381333930')).toBe('check-digit');
  });

  it('flags digits of no recognised GTIN width', () => {
    expect(describeGtinConcern('12345')).toBe('length');
    expect(describeGtinConcern('4006381333')).toBe('length'); // 10 — between UPC-A and EAN-13
    // A partially-typed EAN-13 passes through 12 digits, which *is* a GTIN width, so it is
    // judged on its check digit rather than its length — hence the blur gate at the call site.
    expect(describeGtinConcern('400638133393')).toBe('check-digit');
  });

  it('never judges a code containing anything but digits', () => {
    // The field legitimately holds internal/Code-128 labels, so these are left alone
    // rather than policed — see the GtinConcern note.
    expect(describeGtinConcern('SHELF-A12')).toBeNull();
    expect(describeGtinConcern('4006 3813 3393 1')).toBeNull();
    expect(describeGtinConcern('X4006381333930')).toBeNull();
  });
});
