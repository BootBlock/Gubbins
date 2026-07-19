import { describe, it, expect } from 'vitest';
import { estimatedValue, poStatusPresentation, totalOrdered, totalReceived } from './po-presentation';

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

// Issue #292: the scale is the currency's minor unit, not a flat two decimals.
describe('currency minor units', () => {
  it('totals a zero-decimal currency (JPY) in whole units', () => {
    // 3 × ¥100.5 is ¥301.5 raw; the yen has no sub-unit, so the published order value is ¥302.
    expect(estimatedValue([{ orderedQty: 3, unitCost: 100.5 }], 0)).toBe(302);
    expect(estimatedValue([{ orderedQty: 2, unitCost: 1249.4 }], 0)).toBe(2499);
  });

  it('keeps the third digit of a three-decimal currency (BHD)', () => {
    // 1000 fils to the dinar: 0.1235 is a real BHD amount at 3dp, which a flat 2dp would lose.
    expect(estimatedValue([{ orderedQty: 1, unitCost: 0.1235 }], 3)).toBe(0.124);
    expect(estimatedValue([{ orderedQty: 3, unitCost: 0.0005 }], 3)).toBe(0.002);
  });

  it('defaults to two decimals when no scale is given, so existing callers are unchanged', () => {
    expect(estimatedValue([{ orderedQty: 3, unitCost: 100.5 }])).toBe(301.5);
  });
});
