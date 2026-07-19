import { describe, it, expect } from 'vitest';
import {
  estimatedValue,
  isCurrencyMismatch,
  normaliseCurrencyCode,
  poStatusPresentation,
  totalOrdered,
  totalReceived,
} from './po-presentation';

describe('poStatusPresentation', () => {
  it('maps every status to a British-English label and a glyph token (never a raw colour)', () => {
    for (const status of ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'] as const) {
      const p = poStatusPresentation(status);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.toneClass.startsWith('text-glyph-')).toBe(true);
    }
  });

  it('uses British spelling for cancelled', () => {
    expect(poStatusPresentation('CANCELLED').label).toBe('Cancelled');
  });
});

describe('line totals', () => {
  const lines = [
    { orderedQty: 10, receivedQty: 4, unitCost: 0.5 },
    { orderedQty: 5, receivedQty: 5, unitCost: null },
    { orderedQty: 2, receivedQty: 0, unitCost: 3 },
  ];

  it('sums ordered and received quantities', () => {
    expect(totalOrdered(lines)).toBe(17);
    expect(totalReceived(lines)).toBe(9);
  });

  it('estimates value only over priced lines', () => {
    // 10 * 0.5 + 2 * 3 = 11 (the unpriced line contributes nothing).
    expect(estimatedValue(lines)).toBe(11);
  });

  it('quantises the estimate, so float drift never reaches the order (issue #288)', () => {
    expect(
      estimatedValue([
        { orderedQty: 3, unitCost: 0.1 },
        { orderedQty: 3, unitCost: 0.1 },
        { orderedQty: 3, unitCost: 0.1 },
      ]),
    ).toBe(0.9);
    expect(estimatedValue([{ orderedQty: 3, unitCost: 1.005 }])).toBe(3.02);
  });
});

describe('normaliseCurrencyCode', () => {
  it('trims and upper-cases a code, collapsing blank and null alike to null', () => {
    expect(normaliseCurrencyCode(' eur ')).toBe('EUR');
    expect(normaliseCurrencyCode('GBP')).toBe('GBP');
    // Blank, whitespace-only and absent all mean "no code of its own" ⇒ the base currency.
    expect(normaliseCurrencyCode('')).toBeNull();
    expect(normaliseCurrencyCode('   ')).toBeNull();
    expect(normaliseCurrencyCode(null)).toBeNull();
    expect(normaliseCurrencyCode(undefined)).toBeNull();
  });
});

describe('isCurrencyMismatch (issue #285)', () => {
  it('flags a supplier quote denominated differently from the order', () => {
    expect(isCurrencyMismatch('EUR', 'GBP', 'GBP')).toBe(true);
    // The order carries no code, so it is in the base currency — still a mismatch.
    expect(isCurrencyMismatch('EUR', null, 'GBP')).toBe(true);
    // …and the other way round: a base-currency quote against a foreign order.
    expect(isCurrencyMismatch(null, 'USD', 'GBP')).toBe(true);
  });

  it('does not flag two codes that name the same currency', () => {
    expect(isCurrencyMismatch('EUR', 'EUR', 'GBP')).toBe(false);
    expect(isCurrencyMismatch('GBP', null, 'GBP')).toBe(false);
    expect(isCurrencyMismatch(null, null, 'GBP')).toBe(false);
    // Scruffy casing and padding name the same currency as the tidy code.
    expect(isCurrencyMismatch(' eur ', 'EUR', 'GBP')).toBe(false);
    expect(isCurrencyMismatch('   ', 'GBP', 'GBP')).toBe(false);
  });

  it('stays silent when the base currency is unknown and either side is blank', () => {
    // An unknown base cannot say whether a blank means the same currency as a stated one;
    // guessing would raise a false alarm on every line, so it fails open like the SQL side.
    expect(isCurrencyMismatch('EUR', null, null)).toBe(false);
    expect(isCurrencyMismatch(null, 'EUR', null)).toBe(false);
    expect(isCurrencyMismatch(null, null, null)).toBe(false);
    // Two explicit, differing codes are still judgeable without a base.
    expect(isCurrencyMismatch('EUR', 'USD', null)).toBe(true);
  });
});
