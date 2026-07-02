import { describe, it, expect } from 'vitest';
import { buildSpendReport, SPEND_SOURCES, type SpendEvent } from './spend-analytics';

/** Terse event builder with sensible defaults. */
function ev(instant: number, amount: number, over: Partial<SpendEvent> = {}): SpendEvent {
  return {
    instant,
    amount,
    source: 'PURCHASE_ORDER',
    supplier: null,
    categoryId: null,
    categoryName: null,
    ...over,
  };
}

describe('buildSpendReport', () => {
  it('returns a zeroed report for no events', () => {
    const report = buildSpendReport([], 0, 100, 5);
    expect(report.total).toBe(0);
    expect(report.eventCount).toBe(0);
    expect(report.buckets).toHaveLength(5);
    expect(report.buckets.every((b) => b.total === 0)).toBe(true);
    // All three sources are always present, each 0.
    expect(report.bySource.map((s) => s.source)).toEqual([...SPEND_SOURCES]);
    expect(report.bySource.every((s) => s.total === 0 && s.share === 0)).toBe(true);
    expect(report.bySupplier).toEqual([]);
    expect(report.byCategory).toEqual([]);
  });

  it('counts events half-open: start included, end excluded', () => {
    const report = buildSpendReport(
      [ev(-1, 10), ev(0, 10), ev(50, 10), ev(99, 10), ev(100, 10), ev(200, 10)],
      0,
      100,
      4,
    );
    // Only instants 0, 50, 99 are in [0,100) → 30 total over 3 events.
    expect(report.total).toBe(30);
    expect(report.eventCount).toBe(3);
  });

  it('ignores non-positive and non-finite amounts', () => {
    const report = buildSpendReport(
      [ev(10, 0), ev(20, -5), ev(30, Number.NaN), ev(40, Infinity), ev(50, 25)],
      0,
      100,
      2,
    );
    expect(report.total).toBe(25);
    expect(report.eventCount).toBe(1);
  });

  it('buckets events into equal half-open spans, last bucket pinned to windowEnd', () => {
    const report = buildSpendReport(
      [ev(0, 1), ev(19, 2), ev(20, 4), ev(99, 8)],
      0,
      100,
      5, // width 20: [0,20) [20,40) [40,60) [60,80) [80,100]
    );
    expect(report.buckets.map((b) => b.total)).toEqual([3, 4, 0, 0, 8]);
    expect(report.buckets[4]!.end).toBe(100);
  });

  it('groups by supplier and category with sorted catch-all buckets', () => {
    const report = buildSpendReport(
      [
        ev(10, 100, { supplier: 'RS', categoryId: 'c1', categoryName: 'Resistors' }),
        ev(20, 40, { supplier: 'RS', categoryId: 'c1', categoryName: 'Resistors' }),
        ev(30, 60, { supplier: 'Mouser', categoryId: 'c2', categoryName: 'Caps' }),
        ev(40, 50, { source: 'PROJECT_EXPENSE' }), // no supplier, no category
      ],
      0,
      100,
      2,
    );
    expect(report.total).toBe(250);
    // Suppliers: RS 140, Mouser 60, No supplier 50 — descending.
    expect(report.bySupplier.map((g) => [g.name, g.total])).toEqual([
      ['RS', 140],
      ['Mouser', 60],
      ['No supplier', 50],
    ]);
    expect(report.bySupplier[0]!.share).toBeCloseTo(140 / 250, 10);
    // Categories: Resistors 140, Caps 60, Uncategorised 50.
    expect(report.byCategory.map((g) => [g.name, g.id, g.total])).toEqual([
      ['Resistors', 'c1', 140],
      ['Caps', 'c2', 60],
      ['Uncategorised', null, 50],
    ]);
  });

  it('tallies by source in fixed order with shares', () => {
    const report = buildSpendReport(
      [
        ev(10, 30, { source: 'PURCHASE_ORDER' }),
        ev(20, 50, { source: 'PROJECT_EXPENSE' }),
        ev(30, 20, { source: 'ACQUISITION' }),
      ],
      0,
      100,
      1,
    );
    expect(report.bySource).toEqual([
      { source: 'PURCHASE_ORDER', total: 30, share: 0.3 },
      { source: 'PROJECT_EXPENSE', total: 50, share: 0.5 },
      { source: 'ACQUISITION', total: 20, share: 0.2 },
    ]);
  });

  it('clamps bucketCount to >= 1 and never divides by zero on a degenerate window', () => {
    const report = buildSpendReport([ev(5, 10)], 5, 5, 0);
    expect(report.buckets).toHaveLength(1);
    expect(report.total).toBeGreaterThanOrEqual(0);
    expect(report.bySource.every((s) => Number.isFinite(s.share))).toBe(true);
  });
});
