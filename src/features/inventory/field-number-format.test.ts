import { describe, it, expect } from 'vitest';
import { FIELD_PRECISION_MAX, FIELD_PRECISION_MIN } from '@/db/repositories/constants';
import { fitsFieldPrecision, formatFieldNumber } from './field-number-format';

/**
 * The two halves of a `NUMBER` definition's decimal places (W1e). They are the same call seen
 * from either side, so the load-bearing property is the one asserted last here: anything
 * {@link fitsFieldPrecision} accepts, {@link formatFieldNumber} only ever *pads*.
 */

describe('formatFieldNumber', () => {
  it('leaves the value untouched when the definition sets no precision', () => {
    // The pre-W1e behaviour, which every existing field keeps: `null` is "as entered".
    expect(formatFieldNumber('5.5', null)).toBe('5.5');
    expect(formatFieldNumber('0.10', null)).toBe('0.10');
  });

  it('pads a short value out to the definition’s decimal places', () => {
    expect(formatFieldNumber('5.5', 2)).toBe('5.50');
    expect(formatFieldNumber('5', 2)).toBe('5.00');
    expect(formatFieldNumber('-0.5', 3)).toBe('-0.500');
  });

  it('writes whole numbers at precision 0 — the case a range cannot express', () => {
    expect(formatFieldNumber('12', 0)).toBe('12');
    // A value that only ever arrives out of band (a peer, an import, a precision tightened
    // afterwards) is rounded rather than shown at a precision the field says it does not use.
    expect(formatFieldNumber('12.6', 0)).toBe('13');
  });

  it('returns a non-numeric value unchanged rather than showing NaN', () => {
    // Only the write seam guarantees a canonical number is stored; a value merged from a peer or
    // restored from a backup has met no such guarantee.
    for (const raw of ['abc', 'Infinity', '1.2.3']) {
      expect(formatFieldNumber(raw, 2)).toBe(raw);
    }
  });

  it('does not turn a blank into a confident 0.00', () => {
    // `Number('')` and `Number(' ')` are both 0, so the blank guard is doing real work here even
    // though every current caller drops blanks before it is reached.
    for (const raw of ['', '   ', '\t\n']) {
      expect(formatFieldNumber(raw, 2)).toBe(raw);
    }
  });

  it('does not group or localise the number', () => {
    // Deliberate: a custom NUMBER is not known to be a count, so `2026` on a "Year built" field
    // must not read `2,026`, and the value box that sets it parses `.`-decimals only.
    expect(formatFieldNumber('1234567.5', 2)).toBe('1234567.50');
  });
});

describe('fitsFieldPrecision', () => {
  it('accepts a value expressible at the precision, however it was written', () => {
    expect(fitsFieldPrecision(5.5, 1)).toBe(true);
    // `5.50` parses to 5.5, which *is* a one-decimal value merely written long.
    expect(fitsFieldPrecision(Number('5.50'), 1)).toBe(true);
    expect(fitsFieldPrecision(5, 0)).toBe(true);
    expect(fitsFieldPrecision(-3, 0)).toBe(true);
  });

  it('refuses a value carrying more decimals than the precision allows', () => {
    expect(fitsFieldPrecision(5.55, 1)).toBe(false);
    expect(fitsFieldPrecision(2.5, 0)).toBe(false);
    expect(fitsFieldPrecision(-0.001, 2)).toBe(false);
  });

  it('refuses a tiny value whose canonical string shows no decimal point at all', () => {
    // The reason this is a round trip rather than a digit count of `String(n)`: `String(1e-7)`
    // is `'1e-7'`, which a naive split on `.` reads as zero decimal places.
    expect(String(1e-7)).toBe('1e-7');
    expect(fitsFieldPrecision(1e-7, 2)).toBe(false);
  });

  it('agrees with formatFieldNumber across the whole permitted precision range', () => {
    const values = [0, 1, 5, 5.5, 5.55, 2.5, -3.25, 1000.125, 0.000001, 1e-7];
    for (let p = FIELD_PRECISION_MIN; p <= FIELD_PRECISION_MAX; p++) {
      for (const n of values) {
        // The property the whole design rests on: an accepted value is only ever padded, never
        // shown as a different number. Compared numerically, since padding changes the text.
        if (fitsFieldPrecision(n, p)) {
          expect(Number(formatFieldNumber(String(n), p))).toBe(n);
        }
      }
    }
  });
});
