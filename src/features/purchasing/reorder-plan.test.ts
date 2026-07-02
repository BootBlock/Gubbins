/**
 * Unit tests for the pure reorder-plan builder (Phase 65).
 *
 * No DB, no clock — every helper and the top-level `buildReorderPlan` function
 * are exercised directly over plain input objects.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReorderPlan,
  computeOrderQty,
  roundUpToPack,
  UNASSIGNED_SUPPLIER_NAME,
  type ReorderShortfallRow,
} from './reorder-plan';

// ---------------------------------------------------------------------------
// roundUpToPack
// ---------------------------------------------------------------------------

describe('roundUpToPack', () => {
  it('returns the value unchanged when packQty is absent', () => {
    expect(roundUpToPack(7, null)).toBe(7);
    expect(roundUpToPack(7, undefined)).toBe(7);
  });

  it('returns the value unchanged when packQty is 1 (no-op)', () => {
    expect(roundUpToPack(7, 1)).toBe(7);
  });

  it('rounds up to the next whole pack', () => {
    expect(roundUpToPack(6, 5)).toBe(10); // 2 packs of 5
    expect(roundUpToPack(1, 10)).toBe(10); // 1 pack of 10
    expect(roundUpToPack(11, 10)).toBe(20); // 2 packs of 10
  });

  it('does not round when the quantity is already an exact multiple', () => {
    expect(roundUpToPack(10, 5)).toBe(10);
    expect(roundUpToPack(10, 10)).toBe(10);
  });

  it('ignores non-finite packQty', () => {
    expect(roundUpToPack(7, Infinity)).toBe(7);
    expect(roundUpToPack(7, NaN)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// computeOrderQty
// ---------------------------------------------------------------------------

describe('computeOrderQty', () => {
  it('returns the shortfall when no MOQ and no packQty', () => {
    expect(computeOrderQty(3, null, null)).toBe(3);
  });

  it('uses the MOQ when it exceeds the shortfall', () => {
    expect(computeOrderQty(2, null, 5)).toBe(5);
  });

  it('uses the shortfall when it exceeds the MOQ', () => {
    expect(computeOrderQty(8, null, 5)).toBe(8);
  });

  it('rounds the (shortfall-or-MOQ) up to a whole pack', () => {
    // shortfall=3, MOQ=5 → needed=5, pack=4 → ceil(5/4)*4 = 8
    expect(computeOrderQty(3, 4, 5)).toBe(8);
    // shortfall=7, MOQ=2 → needed=7, pack=5 → ceil(7/5)*5 = 10
    expect(computeOrderQty(7, 5, 2)).toBe(10);
  });

  it('handles zero MOQ (treated as no MOQ)', () => {
    expect(computeOrderQty(3, null, 0)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildReorderPlan
// ---------------------------------------------------------------------------

describe('buildReorderPlan', () => {
  it('returns an empty array for empty input', () => {
    expect(buildReorderPlan([])).toEqual([]);
  });

  it('ignores rows with zero or negative shortfall', () => {
    const rows: ReorderShortfallRow[] = [
      { itemId: 'a', itemName: 'Item A', shortfall: 0 },
      { itemId: 'b', itemName: 'Item B', shortfall: -1 },
    ];
    expect(buildReorderPlan(rows)).toHaveLength(0);
  });

  it('places items with no preferred supplier into the Unassigned group', () => {
    const rows: ReorderShortfallRow[] = [{ itemId: 'x', itemName: 'Widget', shortfall: 3 }];
    const plan = buildReorderPlan(rows);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.supplierName).toBe(UNASSIGNED_SUPPLIER_NAME);
    expect(plan[0]!.supplierKey).toBe('~unassigned');
    expect(plan[0]!.lines[0]!.supplierPartId).toBeNull();
    expect(plan[0]!.lines[0]!.orderQty).toBe(3);
  });

  it('groups items by their preferred supplier', () => {
    const rows: ReorderShortfallRow[] = [
      {
        itemId: 'a',
        itemName: 'Screw',
        shortfall: 5,
        preferredSupplier: { supplierPartId: 'sp1', supplierName: 'DigiKey', unitCost: 0.1 },
      },
      {
        itemId: 'b',
        itemName: 'Cap',
        shortfall: 10,
        preferredSupplier: { supplierPartId: 'sp2', supplierName: 'Mouser', unitCost: 0.2 },
      },
      {
        itemId: 'c',
        itemName: 'Resistor',
        shortfall: 20,
        preferredSupplier: { supplierPartId: 'sp3', supplierName: 'DigiKey', unitCost: 0.05 },
      },
    ];
    const plan = buildReorderPlan(rows);
    // DigiKey and Mouser — alphabetically DigiKey first.
    expect(plan).toHaveLength(2);
    expect(plan[0]!.supplierName).toBe('DigiKey');
    expect(plan[0]!.lines).toHaveLength(2);
    expect(plan[1]!.supplierName).toBe('Mouser');
    expect(plan[1]!.lines).toHaveLength(1);
  });

  it('sorts named suppliers alphabetically, with Unassigned last', () => {
    const rows: ReorderShortfallRow[] = [
      {
        itemId: 'a',
        itemName: 'A',
        shortfall: 1,
        preferredSupplier: { supplierPartId: 'sp1', supplierName: 'RS Components' },
      },
      { itemId: 'b', itemName: 'B', shortfall: 1 }, // no supplier
      {
        itemId: 'c',
        itemName: 'C',
        shortfall: 1,
        preferredSupplier: { supplierPartId: 'sp2', supplierName: 'Farnell' },
      },
    ];
    const plan = buildReorderPlan(rows);
    expect(plan.map((g) => g.supplierName)).toEqual(['Farnell', 'RS Components', UNASSIGNED_SUPPLIER_NAME]);
  });

  it('applies MOQ rounding correctly', () => {
    const rows: ReorderShortfallRow[] = [
      {
        itemId: 'a',
        itemName: 'Chip',
        shortfall: 2,
        preferredSupplier: {
          supplierPartId: 'sp1',
          supplierName: 'DigiKey',
          packQty: 10,
          minOrderQty: 5,
          unitCost: 0.5,
        },
      },
    ];
    const plan = buildReorderPlan(rows);
    // shortfall=2, MOQ=5 → needed=5, pack=10 → roundUp(5,10)=10
    expect(plan[0]!.lines[0]!.orderQty).toBe(10);
  });

  it('uses shortfall when it exceeds MOQ and rounds to pack', () => {
    const rows: ReorderShortfallRow[] = [
      {
        itemId: 'a',
        itemName: 'Bolt',
        shortfall: 13,
        preferredSupplier: {
          supplierPartId: 'sp1',
          supplierName: 'Fabory',
          packQty: 5,
          minOrderQty: 2,
        },
      },
    ];
    const plan = buildReorderPlan(rows);
    // shortfall=13, MOQ=2 → needed=13, pack=5 → ceil(13/5)*5=15
    expect(plan[0]!.lines[0]!.orderQty).toBe(15);
  });

  it('propagates supplierPartId and unitCost onto the plan line', () => {
    const rows: ReorderShortfallRow[] = [
      {
        itemId: 'i1',
        itemName: 'LED',
        shortfall: 4,
        preferredSupplier: {
          supplierPartId: 'sp-abc',
          supplierName: 'Mouser',
          unitCost: 0.12,
        },
      },
    ];
    const plan = buildReorderPlan(rows);
    const line = plan[0]!.lines[0]!;
    expect(line.supplierPartId).toBe('sp-abc');
    expect(line.unitCost).toBe(0.12);
    expect(line.itemId).toBe('i1');
    expect(line.itemName).toBe('LED');
  });

  it('mixed: supplier and unassigned items in one pass', () => {
    const rows: ReorderShortfallRow[] = [
      {
        itemId: 'a',
        itemName: 'Part A',
        shortfall: 5,
        preferredSupplier: { supplierPartId: 'sp1', supplierName: 'Alpha Supply' },
      },
      { itemId: 'b', itemName: 'Part B', shortfall: 3 },
      { itemId: 'c', itemName: 'Part C', shortfall: 0 }, // zero shortfall — ignored
      {
        itemId: 'd',
        itemName: 'Part D',
        shortfall: 1,
        preferredSupplier: { supplierPartId: 'sp2', supplierName: 'Alpha Supply' },
      },
    ];
    const plan = buildReorderPlan(rows);
    // Alpha Supply + Unassigned; Alpha Supply first alphabetically.
    expect(plan).toHaveLength(2);
    expect(plan[0]!.supplierName).toBe('Alpha Supply');
    expect(plan[0]!.lines).toHaveLength(2); // a + d
    expect(plan[1]!.supplierName).toBe(UNASSIGNED_SUPPLIER_NAME);
    expect(plan[1]!.lines).toHaveLength(1); // b only (c skipped)
  });
});
