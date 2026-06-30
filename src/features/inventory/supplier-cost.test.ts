import { describe, it, expect } from 'vitest';
import {
  effectiveUnitCost,
  preferredSupplierPart,
  type CostSupplierPartLike,
} from './supplier-cost';

const part = (unitCost: number | null, isPreferred: boolean): CostSupplierPartLike => ({
  unitCost,
  isPreferred,
});

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
