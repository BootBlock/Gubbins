import { describe, it, expect } from 'vitest';
import {
  effectiveUnitCost,
  effectiveUnitCostForQty,
  preferredSupplierPart,
  unitCostForQty,
  type CostSupplierPartLike,
  type PricedSupplierPartLike,
} from './supplier-cost';
import type { PriceBreak } from '@/db/repositories';

const part = (unitCost: number | null, isPreferred: boolean): CostSupplierPartLike => ({
  unitCost,
  isPreferred,
});

const pricedPart = (
  unitCost: number | null,
  priceBreaks: readonly PriceBreak[],
  isPreferred = true,
): PricedSupplierPartLike => ({ unitCost, isPreferred, priceBreaks });

describe('preferredSupplierPart', () => {
  it('returns the preferred part', () => {
    const parts = [part(1, false), part(2, true), part(3, false)];
    expect(preferredSupplierPart(parts)).toBe(parts[1]);
  });

  it('returns undefined when none is preferred', () => {
    expect(preferredSupplierPart([part(1, false), part(2, false)])).toBeUndefined();
  });
});

describe('effectiveUnitCost', () => {
  it('a manual unitCost always wins over the preferred supplier cost', () => {
    expect(effectiveUnitCost({ unitCost: 5 }, [part(2, true)])).toBe(5);
  });

  it('falls back to the preferred supplier cost when manual is null', () => {
    expect(effectiveUnitCost({ unitCost: null }, [part(2, true), part(9, false)])).toBe(2);
  });

  it('ignores a non-preferred supplier cost', () => {
    expect(effectiveUnitCost({ unitCost: null }, [part(2, false)])).toBeNull();
  });

  it('falls back to null when the preferred part is itself unpriced', () => {
    expect(effectiveUnitCost({ unitCost: null }, [part(null, true)])).toBeNull();
  });

  it('returns null when there are no supplier parts and no manual cost', () => {
    expect(effectiveUnitCost({ unitCost: null }, [])).toBeNull();
  });

  it('treats a zero manual cost as a real (free) price, not unset', () => {
    expect(effectiveUnitCost({ unitCost: 0 }, [part(2, true)])).toBe(0);
  });

  it('ignores a negative/NaN manual cost and falls through to the preferred part', () => {
    expect(effectiveUnitCost({ unitCost: -1 }, [part(2, true)])).toBe(2);
    expect(effectiveUnitCost({ unitCost: Number.NaN }, [part(2, true)])).toBe(2);
  });
});

describe('unitCostForQty', () => {
  const breaks: PriceBreak[] = [
    { qty: 10, unitCost: 0.9 },
    { qty: 100, unitCost: 0.75 },
    { qty: 1000, unitCost: 0.5 },
  ];

  it('uses the flat cost below the first break threshold', () => {
    expect(unitCostForQty(pricedPart(1, breaks), 1)).toBe(1);
    expect(unitCostForQty(pricedPart(1, breaks), 9)).toBe(1);
  });

  it('applies a break exactly at its threshold', () => {
    expect(unitCostForQty(pricedPart(1, breaks), 10)).toBe(0.9);
    expect(unitCostForQty(pricedPart(1, breaks), 100)).toBe(0.75);
  });

  it('applies the highest qualifying break between thresholds', () => {
    expect(unitCostForQty(pricedPart(1, breaks), 50)).toBe(0.9);
    expect(unitCostForQty(pricedPart(1, breaks), 500)).toBe(0.75);
    expect(unitCostForQty(pricedPart(1, breaks), 5000)).toBe(0.5);
  });

  it('leaves the flat cost unchanged when there are no breaks', () => {
    expect(unitCostForQty(pricedPart(2.5, []), 1000)).toBe(2.5);
  });

  it('falls back to a qualifying break when the flat cost is unset', () => {
    expect(unitCostForQty(pricedPart(null, breaks), 100)).toBe(0.75);
  });

  it('returns null when the flat cost is unset and no break qualifies', () => {
    expect(unitCostForQty(pricedPart(null, breaks), 5)).toBeNull();
  });

  it('treats a zero-priced break as a real (free) price', () => {
    expect(unitCostForQty(pricedPart(1, [{ qty: 10, unitCost: 0 }]), 10)).toBe(0);
  });

  it('qualifies no break for a non-positive or fractional-below-threshold quantity', () => {
    expect(unitCostForQty(pricedPart(1, breaks), 0)).toBe(1);
    expect(unitCostForQty(pricedPart(1, breaks), 9.5)).toBe(1);
  });
});

describe('effectiveUnitCostForQty', () => {
  const breaks: PriceBreak[] = [
    { qty: 10, unitCost: 0.9 },
    { qty: 100, unitCost: 0.75 },
  ];

  it('a manual unitCost wins outright, regardless of quantity or breaks', () => {
    expect(effectiveUnitCostForQty({ unitCost: 5 }, [pricedPart(1, breaks)], 100)).toBe(5);
  });

  it('applies the preferred supplier price-break for the quantity when no manual cost', () => {
    expect(effectiveUnitCostForQty({ unitCost: null }, [pricedPart(1, breaks)], 100)).toBe(0.75);
    expect(effectiveUnitCostForQty({ unitCost: null }, [pricedPart(1, breaks)], 5)).toBe(1);
  });

  it('ignores a non-preferred supplier part', () => {
    expect(effectiveUnitCostForQty({ unitCost: null }, [pricedPart(1, breaks, false)], 100)).toBeNull();
  });

  it('returns null with no manual cost and no supplier parts', () => {
    expect(effectiveUnitCostForQty({ unitCost: null }, [], 100)).toBeNull();
  });
});
