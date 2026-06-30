import { describe, it, expect } from 'vitest';
import {
  estimatedValue,
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
});
