import { describe, expect, it } from 'vitest';
import { hasValidGtinCheckDigit, isValidGtin, parseGtin } from './gtin';

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
