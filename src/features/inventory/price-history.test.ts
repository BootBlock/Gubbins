import { describe, expect, it } from 'vitest';
import type { SupplierPartPriceHistoryEntry } from '@/db/repositories';
import { buildPriceSeries, sparklinePolyline } from './price-history';

function point(unitCost: number, recordedAt: number): SupplierPartPriceHistoryEntry {
  return {
    id: `p-${recordedAt}`,
    supplierPartId: 'sp-1',
    unitCost,
    currency: 'GBP',
    source: 'MANUAL',
    recordedAt,
    updatedAt: recordedAt,
  };
}

describe('buildPriceSeries (Phase 81)', () => {
  it('handles an empty series', () => {
    const s = buildPriceSeries([]);
    expect(s.count).toBe(0);
    expect(s.first).toBeNull();
    expect(s.latest).toBeNull();
    expect(s.changeAbs).toBeNull();
    expect(s.changePct).toBeNull();
    expect(s.direction).toBe('none');
  });

  it('handles a single point (no change, flat)', () => {
    const s = buildPriceSeries([point(5, 100)]);
    expect(s.count).toBe(1);
    expect(s.first?.unitCost).toBe(5);
    expect(s.latest?.unitCost).toBe(5);
    expect(s.min).toBe(5);
    expect(s.max).toBe(5);
    expect(s.changeAbs).toBeNull();
    expect(s.changePct).toBeNull();
    expect(s.direction).toBe('flat');
  });

  it('sorts ascending by recordedAt regardless of input order', () => {
    const s = buildPriceSeries([point(3, 300), point(1, 100), point(2, 200)]);
    expect(s.points.map((p) => p.unitCost)).toEqual([1, 2, 3]);
    expect(s.first?.unitCost).toBe(1);
    expect(s.latest?.unitCost).toBe(3);
  });

  it('computes a rising trend', () => {
    const s = buildPriceSeries([point(10, 100), point(15, 200)]);
    expect(s.changeAbs).toBe(5);
    expect(s.changePct).toBe(50);
    expect(s.direction).toBe('up');
    expect(s.min).toBe(10);
    expect(s.max).toBe(15);
  });

  it('computes a falling trend', () => {
    const s = buildPriceSeries([point(20, 100), point(15, 200)]);
    expect(s.changeAbs).toBe(-5);
    expect(s.changePct).toBe(-25);
    expect(s.direction).toBe('down');
  });

  it('reports a flat trend when first === latest across multiple points', () => {
    const s = buildPriceSeries([point(8, 100), point(9, 150), point(8, 200)]);
    expect(s.changeAbs).toBe(0);
    expect(s.changePct).toBe(0);
    expect(s.direction).toBe('flat');
    expect(s.max).toBe(9);
  });

  it('guards divide-by-zero when the first cost is 0', () => {
    const s = buildPriceSeries([point(0, 100), point(5, 200)]);
    expect(s.changeAbs).toBe(5);
    expect(s.changePct).toBeNull();
    expect(s.direction).toBe('up');
  });
});

describe('sparklinePolyline (Phase 81)', () => {
  it('returns an empty string for no values', () => {
    expect(sparklinePolyline([], 100, 20)).toBe('');
  });

  it('renders a single value as a mid-height line', () => {
    expect(sparklinePolyline([7], 100, 20)).toBe('0,10 100,10');
  });

  it('renders a flat multi-value series as a mid-line', () => {
    expect(sparklinePolyline([5, 5, 5], 100, 20)).toBe('0,10 50,10 100,10');
  });

  it('inverts y so the max sits at the top and min at the bottom', () => {
    const out = sparklinePolyline([10, 20], 100, 20);
    // First point (min) at the bottom (y=height), second (max) at the top (y=0).
    expect(out).toBe('0,20 100,0');
  });

  it('spaces points evenly across the width', () => {
    const out = sparklinePolyline([1, 2, 3], 100, 20);
    const xs = out.split(' ').map((pt) => Number(pt.split(',')[0]));
    expect(xs).toEqual([0, 50, 100]);
  });
});
