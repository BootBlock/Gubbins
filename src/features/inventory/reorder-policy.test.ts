import { describe, it, expect } from 'vitest';
import {
  effectiveGaugePercent,
  effectiveQtyThreshold,
  isLow,
  shortfall,
  type ReorderDefaults,
  type ReorderItem,
} from './reorder-policy';

const DEFAULTS: ReorderDefaults = { qtyThreshold: 5, gaugePercent: 15 };

function discrete(quantity: number, overrides: Partial<ReorderItem> = {}): ReorderItem {
  return {
    trackingMode: 'DISCRETE',
    quantity,
    gauge: null,
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    ...overrides,
  };
}

function gauge(percentageRemaining: number, overrides: Partial<ReorderItem> = {}): ReorderItem {
  return {
    trackingMode: 'CONSUMABLE_GAUGE',
    quantity: 0,
    gauge: {
      unitOfMeasure: 'g',
      grossCapacity: 1000,
      tareWeight: 0,
      currentNetValue: (percentageRemaining / 100) * 1000,
      percentageRemaining,
      currentGrossWeight: (percentageRemaining / 100) * 1000,
    },
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    ...overrides,
  };
}

describe('reorder-policy — effective thresholds', () => {
  it('falls back to the global default when the item has no override', () => {
    expect(effectiveQtyThreshold(discrete(0), DEFAULTS)).toBe(5);
    expect(effectiveGaugePercent(gauge(50), DEFAULTS)).toBe(15);
  });

  it('uses the per-item override when set (incl. zero)', () => {
    expect(effectiveQtyThreshold(discrete(0, { reorderPoint: 20 }), DEFAULTS)).toBe(20);
    expect(effectiveQtyThreshold(discrete(0, { reorderPoint: 0 }), DEFAULTS)).toBe(0);
    expect(effectiveGaugePercent(gauge(50, { reorderGaugePercent: 40 }), DEFAULTS)).toBe(40);
    expect(effectiveGaugePercent(gauge(50, { reorderGaugePercent: 0 }), DEFAULTS)).toBe(0);
  });
});

describe('reorder-policy — isLow', () => {
  it('flags a DISCRETE item at/below the global default', () => {
    expect(isLow(discrete(5), DEFAULTS)).toBe(true); // at threshold
    expect(isLow(discrete(4), DEFAULTS)).toBe(true);
    expect(isLow(discrete(6), DEFAULTS)).toBe(false);
  });

  it('honours a higher per-item reorder point (low where the global would not flag)', () => {
    expect(isLow(discrete(15, { reorderPoint: 20 }), DEFAULTS)).toBe(true);
    expect(isLow(discrete(15), DEFAULTS)).toBe(false); // 15 > global 5
  });

  it('honours a lower per-item reorder point (not low where the global would flag)', () => {
    expect(isLow(discrete(3, { reorderPoint: 2 }), DEFAULTS)).toBe(false);
    expect(isLow(discrete(3), DEFAULTS)).toBe(true); // 3 <= global 5
  });

  it('flags a CONSUMABLE_GAUGE item at/below its effective percentage floor', () => {
    expect(isLow(gauge(15), DEFAULTS)).toBe(true); // at default
    expect(isLow(gauge(10), DEFAULTS)).toBe(true);
    expect(isLow(gauge(20), DEFAULTS)).toBe(false);
    expect(isLow(gauge(30, { reorderGaugePercent: 40 }), DEFAULTS)).toBe(true);
    expect(isLow(gauge(30), DEFAULTS)).toBe(false);
  });

  it('never flags a gauge with no usable capacity', () => {
    const empty = gauge(0, {
      gauge: {
        unitOfMeasure: 'g',
        grossCapacity: 0,
        tareWeight: 0,
        currentNetValue: 0,
        percentageRemaining: 0,
        currentGrossWeight: 0,
      },
    });
    expect(isLow(empty, DEFAULTS)).toBe(false);
  });

  it('never flags a SERIALISED single asset', () => {
    expect(isLow(discrete(1, { trackingMode: 'SERIALISED' }), DEFAULTS)).toBe(false);
  });

  it('never flags an UNTRACKED presence-only item (its permanent 0 is not "low")', () => {
    expect(isLow(discrete(0, { trackingMode: 'UNTRACKED' }), DEFAULTS)).toBe(false);
    expect(isLow(discrete(0, { trackingMode: 'UNTRACKED', reorderPoint: 20 }), DEFAULTS)).toBe(false);
  });
});

describe('reorder-policy — shortfall', () => {
  it('returns 0 when the item is not low', () => {
    expect(shortfall(discrete(10), DEFAULTS)).toBe(0);
  });

  it('returns the gap up to the effective floor when low and no explicit top-up', () => {
    expect(shortfall(discrete(2), DEFAULTS)).toBe(3); // 5 - 2
    expect(shortfall(discrete(2, { reorderPoint: 20 }), DEFAULTS)).toBe(18); // 20 - 2
  });

  it('prefers an explicit per-item reorder quantity when set', () => {
    expect(shortfall(discrete(2, { reorderQty: 50 }), DEFAULTS)).toBe(50);
    // An explicit top-up still only applies when the item is actually low.
    expect(shortfall(discrete(100, { reorderQty: 50 }), DEFAULTS)).toBe(0);
  });

  it('returns 0 for a gauge item (continuous material, not countable units)', () => {
    expect(shortfall(gauge(5), DEFAULTS)).toBe(0);
  });
});
