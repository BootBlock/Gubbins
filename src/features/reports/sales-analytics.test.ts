import { describe, it, expect } from 'vitest';
import { buildSalesReport, type SalesEvent } from './sales-analytics';

/** Terse event builder with sensible defaults (a sale of 1 unit). */
function ev(instant: number, over: Partial<SalesEvent> = {}): SalesEvent {
  return {
    instant,
    kind: 'SOLD',
    quantity: 1,
    proceeds: 0,
    cost: null,
    categoryId: null,
    categoryName: null,
    ...over,
  };
}

describe('buildSalesReport', () => {
  it('returns a zeroed report for no events', () => {
    const report = buildSalesReport([], 0, 100, 5);
    expect(report.proceeds).toBe(0);
    expect(report.cogs).toBe(0);
    expect(report.margin).toBe(0);
    expect(report.marginPct).toBe(0);
    expect(report.unitsSold).toBe(0);
    expect(report.saleCount).toBe(0);
    expect(report.writeOffCount).toBe(0);
    expect(report.buckets).toHaveLength(5);
    expect(report.byCategory).toEqual([]);
  });

  it('counts events half-open: start included, end excluded', () => {
    const report = buildSalesReport(
      [
        ev(-1, { proceeds: 10 }),
        ev(0, { proceeds: 10 }),
        ev(99, { proceeds: 10 }),
        ev(100, { proceeds: 10 }),
      ],
      0,
      100,
      4,
    );
    // Only instants 0 and 99 are in [0,100) → 20 proceeds over 2 sales.
    expect(report.proceeds).toBe(20);
    expect(report.saleCount).toBe(2);
  });

  it('computes proceeds, COGS and margin from costed sales', () => {
    const report = buildSalesReport(
      [
        ev(10, { quantity: 2, proceeds: 30, cost: 20 }), // margin 10
        ev(20, { quantity: 1, proceeds: 15, cost: 9 }), // margin 6
      ],
      0,
      100,
      4,
    );
    expect(report.proceeds).toBe(45);
    expect(report.cogs).toBe(29);
    expect(report.margin).toBe(16);
    expect(report.unitsSold).toBe(3);
    expect(report.marginPct).toBeCloseTo(16 / 45, 6);
    expect(report.unitsWithoutCost).toBe(0);
  });

  it('excludes uncosted sales from COGS but still counts their proceeds and units', () => {
    const report = buildSalesReport(
      [
        ev(10, { quantity: 2, proceeds: 40, cost: null }), // no cost
        ev(20, { quantity: 1, proceeds: 10, cost: 4 }),
      ],
      0,
      100,
      4,
    );
    expect(report.proceeds).toBe(50);
    expect(report.cogs).toBe(4);
    expect(report.margin).toBe(46);
    expect(report.unitsSold).toBe(3);
    expect(report.unitsWithoutCost).toBe(2);
  });

  it('tracks write-offs separately from sales (no proceeds, cost as loss)', () => {
    const report = buildSalesReport(
      [
        ev(10, { quantity: 1, proceeds: 20, cost: 12 }),
        ev(20, { kind: 'WRITTEN_OFF', quantity: 3, proceeds: 0, cost: 15 }),
      ],
      0,
      100,
      4,
    );
    expect(report.proceeds).toBe(20);
    expect(report.cogs).toBe(12);
    expect(report.saleCount).toBe(1);
    expect(report.writeOffCount).toBe(1);
    expect(report.writeOffUnits).toBe(3);
    expect(report.writeOffValue).toBe(15);
  });

  it('groups sales by category, highest proceeds first, with an uncategorised catch-all', () => {
    const report = buildSalesReport(
      [
        ev(10, { proceeds: 5, categoryId: 'a', categoryName: 'Alpha' }),
        ev(20, { proceeds: 30, categoryId: 'b', categoryName: 'Bravo' }),
        ev(30, { proceeds: 7, categoryId: null }),
      ],
      0,
      100,
      4,
    );
    expect(report.byCategory.map((g) => g.name)).toEqual(['Bravo', 'Uncategorised', 'Alpha']);
    expect(report.byCategory[0]!.proceeds).toBe(30);
    expect(report.byCategory[0]!.share).toBeCloseTo(30 / 42, 6);
  });

  it('ignores events with a non-positive quantity', () => {
    const report = buildSalesReport([ev(10, { quantity: 0, proceeds: 100 })], 0, 100, 4);
    expect(report.saleCount).toBe(0);
    expect(report.proceeds).toBe(0);
  });

  // Issue #288: money accumulated raw and quantised once at the boundary.
  describe('monetary rounding', () => {
    it('totals the split-penny case exactly, not 0.8999999999999999', () => {
      // Three sales of 3 units at 0.10 — the classic split total.
      const lineProceeds = 0.1 * 3;
      const report = buildSalesReport(
        [10, 20, 30].map((t) => ev(t, { quantity: 3, proceeds: lineProceeds })),
        0,
        100,
        1,
      );
      expect(report.proceeds).toBe(0.9);
      expect(report.buckets[0]!.proceeds).toBe(0.9);
      expect(report.byCategory[0]!.proceeds).toBe(0.9);
    });

    it('quantises the headline to the minor unit from raw accumulated amounts', () => {
      const report = buildSalesReport(
        [
          ev(10, { proceeds: 0.1, cost: 0.07, categoryId: 'a', categoryName: 'Alpha' }),
          ev(30, { proceeds: 0.2, cost: 0.03, categoryId: 'b', categoryName: 'Bravo' }),
          ev(60, { proceeds: 0.7, cost: 0.1, categoryId: 'a', categoryName: 'Alpha' }),
        ],
        0,
        100,
        4,
      );
      expect(report.proceeds).toBe(1);
      expect(report.cogs).toBe(0.2);
      expect(report.margin).toBe(0.8);
    });

    it('derives margin from the published proceeds and COGS at every level', () => {
      // Amounts chosen so the raw difference and the published difference disagree: raw
      // proceeds 0.005 / cost 0.004 publish as 0.01 / 0.00, so a margin taken from the raw
      // difference would read 0.00 against two figures that visibly subtract to 0.01.
      const report = buildSalesReport(
        [ev(10, { proceeds: 0.005, cost: 0.004, categoryId: 'a', categoryName: 'Alpha' })],
        0,
        100,
        1,
      );
      expect(report.proceeds).toBe(0.01);
      expect(report.cogs).toBe(0);
      expect(report.margin).toBe(0.01);
      expect(report.buckets[0]!.margin).toBe(report.buckets[0]!.proceeds - report.buckets[0]!.cogs);
      expect(report.byCategory[0]!.margin).toBe(report.byCategory[0]!.proceeds - report.byCategory[0]!.cogs);
    });

    it('quantises the write-off value too', () => {
      const report = buildSalesReport(
        [10, 20, 30].map((t) => ev(t, { kind: 'WRITTEN_OFF', quantity: 3, cost: 0.1 * 3 })),
        0,
        100,
        1,
      );
      expect(report.writeOffValue).toBe(0.9);
    });

    it('computes ratios from the raw totals, so a share is not skewed by rounded pennies', () => {
      const report = buildSalesReport(
        [
          ev(10, { proceeds: 0.001, categoryId: 'a', categoryName: 'Alpha' }),
          ev(20, { proceeds: 0.999, categoryId: 'b', categoryName: 'Bravo' }),
        ],
        0,
        100,
        1,
      );
      // Alpha rounds to 0.00 as an amount but still holds 0.1% of the raw proceeds.
      const alpha = report.byCategory.find((g) => g.id === 'a')!;
      expect(alpha.proceeds).toBe(0);
      expect(alpha.share).toBeCloseTo(0.001, 6);
    });
  });
});
