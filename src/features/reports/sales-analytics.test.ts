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
    expect(report.costedProceeds).toBe(0);
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
    // Every sale carried a cost, so the margin's revenue base is the whole of the proceeds.
    expect(report.costedProceeds).toBe(45);
    expect(report.cogs).toBe(29);
    expect(report.margin).toBe(16);
    expect(report.unitsSold).toBe(3);
    expect(report.marginPct).toBeCloseTo(16 / 45, 6);
    expect(report.unitsWithoutCost).toBe(0);
  });

  it('keeps an uncosted sale out of the margin on both sides, but counts its proceeds and units', () => {
    const report = buildSalesReport(
      [
        ev(10, { quantity: 2, proceeds: 40, cost: null }), // no cost
        ev(20, { quantity: 1, proceeds: 10, cost: 4 }),
      ],
      0,
      100,
      4,
    );
    // The 40 really was taken, so it counts as revenue…
    expect(report.proceeds).toBe(50);
    // …but only the costed sale's 10 backs the margin, so the uncosted line cannot book as profit.
    expect(report.costedProceeds).toBe(10);
    expect(report.cogs).toBe(4);
    expect(report.margin).toBe(6);
    expect(report.marginPct).toBeCloseTo(6 / 10, 6);
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

  // Issue #292: the scale is the currency's minor unit, not a flat 2dp.
  describe('currency minor unit', () => {
    it('quantises to whole units for a 0-decimal currency (JPY), keeping margin exact', () => {
      const report = buildSalesReport(
        [
          ev(10, { proceeds: 100.5, cost: 40.4, categoryId: 'a', categoryName: 'Alpha' }),
          ev(30, { proceeds: 200.25, cost: 10.1, categoryId: 'b', categoryName: 'Bravo' }),
        ],
        0,
        100,
        2,
        0,
      );
      // Raw 300.75 / 50.5 → whole yen, half away from zero. A JPY figure cannot hold a fraction,
      // so publishing 300.75 would be a total the currency is never written in.
      expect(report.proceeds).toBe(301);
      expect(report.cogs).toBe(51);
      // The #288 guarantee still holds at this scale: the published figures subtract exactly.
      expect(report.margin).toBe(250);
      expect(report.margin).toBe(report.proceeds - report.cogs);
      for (const bucket of report.buckets) {
        expect(Number.isInteger(bucket.proceeds)).toBe(true);
        expect(bucket.margin).toBe(bucket.proceeds - bucket.cogs);
      }
      for (const group of report.byCategory) {
        expect(Number.isInteger(group.proceeds)).toBe(true);
        expect(group.margin).toBe(group.proceeds - group.cogs);
      }
    });

    it('preserves the third digit for a 3-decimal currency (BHD)', () => {
      const report = buildSalesReport(
        [ev(10, { proceeds: 1.0005, cost: 0.0004, categoryId: 'a', categoryName: 'Alpha' })],
        0,
        100,
        1,
        3,
      );
      // At the default 2dp this would publish 1.00 and discard a fils the amount genuinely has.
      expect(report.proceeds).toBe(1.001);
      expect(report.cogs).toBe(0);
      expect(report.margin).toBe(1.001);
      expect(report.byCategory[0]!.proceeds).toBe(1.001);
    });

    it('rounds the write-off value to the minor unit too', () => {
      const report = buildSalesReport(
        [ev(10, { kind: 'WRITTEN_OFF', quantity: 3, cost: 100.5 })],
        0,
        100,
        1,
        0,
      );
      expect(report.writeOffValue).toBe(101);
    });
  });

  // Issue #400: each breakdown column re-adds to its headline, apportioning the rounding remainder
  // rather than rounding every row on its own. Only visible under a 0-decimal currency, where the
  // per-row gap is a whole unit rather than a sub-penny.
  describe('breakdowns re-add to their headline (issue #400)', () => {
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

    it('makes the bucket and category columns sum to the headline under a 0-decimal currency', () => {
      // Three ¥100.5 sales in distinct buckets and categories. Rounded on their own each proceeds
      // row carries up to ¥101 → ¥303, but the raw total ¥301.5 publishes as ¥302: a visible ¥1
      // gap the apportionment closes.
      const report = buildSalesReport(
        [
          ev(10, { proceeds: 100.5, cost: 40.5, categoryId: 'a', categoryName: 'Alpha' }),
          ev(40, { proceeds: 100.5, cost: 40.5, categoryId: 'b', categoryName: 'Bravo' }),
          ev(70, { proceeds: 100.5, cost: 40.5, categoryId: 'c', categoryName: 'Cair' }),
        ],
        0,
        90,
        3,
        0, // JPY — whole units
      );
      expect(report.proceeds).toBe(302); // raw 301.5 → 302
      expect(report.cogs).toBe(122); // raw 121.5 → 122
      // The columns sum to the published headline exactly, not to 303 as naive rounding would.
      expect(sum(report.buckets.map((b) => b.proceeds))).toBe(report.proceeds);
      expect(sum(report.buckets.map((b) => b.cogs))).toBe(report.cogs);
      expect(sum(report.byCategory.map((g) => g.proceeds))).toBe(report.proceeds);
      expect(sum(report.byCategory.map((g) => g.cogs))).toBe(report.cogs);
      // Apportioning proceeds and COGS makes the derived margin column add up for free.
      expect(sum(report.byCategory.map((g) => g.margin))).toBe(report.margin);
      expect(sum(report.buckets.map((b) => b.margin))).toBe(report.margin);
      // Every published row is still a whole yen — the apportionment never invents a fraction.
      for (const b of report.buckets) expect(Number.isInteger(b.proceeds)).toBe(true);
      for (const g of report.byCategory) expect(Number.isInteger(g.proceeds)).toBe(true);
    });

    it('apportions the costed-proceeds column too, so a mixed-cost margin still re-adds', () => {
      // Two costed ¥100.5 sales and one uncosted, each in its own bucket and category. The costed
      // column (raw ¥201) and the full proceeds column (raw ¥301.5) have different headlines, so
      // the margin rows only sum to the headline if costed proceeds is apportioned on its own
      // rather than derived from the proceeds column.
      const report = buildSalesReport(
        [
          ev(10, { proceeds: 100.5, cost: 40.5, categoryId: 'a', categoryName: 'Alpha' }),
          ev(40, { proceeds: 100.5, cost: 40.5, categoryId: 'b', categoryName: 'Bravo' }),
          ev(70, { proceeds: 100.5, cost: null, categoryId: 'c', categoryName: 'Cair' }),
        ],
        0,
        90,
        3,
        0, // JPY — whole units
      );
      expect(report.proceeds).toBe(302); // raw 301.5 → 302
      expect(report.costedProceeds).toBe(201);
      expect(report.cogs).toBe(81);
      expect(report.margin).toBe(120);
      expect(sum(report.buckets.map((b) => b.costedProceeds))).toBe(report.costedProceeds);
      expect(sum(report.byCategory.map((g) => g.costedProceeds))).toBe(report.costedProceeds);
      expect(sum(report.buckets.map((b) => b.margin))).toBe(report.margin);
      expect(sum(report.byCategory.map((g) => g.margin))).toBe(report.margin);
    });
  });

  // Issue #694: an uncosted sale used to contribute its full proceeds and no COGS, so it booked as
  // 100% margin and lifted a headline the report's own caveat said excluded it.
  describe('an uncosted sale never lifts the margin (issue #694)', () => {
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

    it('publishes the costed sale’s own margin, not one inflated by unpriced stock', () => {
      // Item A cost £6 and sold for £10; item B has no cost basis and sold for £10.
      const report = buildSalesReport(
        [ev(10, { proceeds: 10, cost: 6 }), ev(20, { proceeds: 10, cost: null })],
        0,
        100,
        4,
      );
      expect(report.proceeds).toBe(20);
      expect(report.costedProceeds).toBe(10);
      expect(report.cogs).toBe(6);
      // Was 14 (£20 − £6) at 70% — the uncosted £10 counted as pure profit.
      expect(report.margin).toBe(4);
      expect(report.marginPct).toBeCloseTo(0.4, 6);
      expect(report.unitsWithoutCost).toBe(1);
    });

    it('holds the uncosted revenue out of each bucket and category margin as well', () => {
      const report = buildSalesReport(
        [
          ev(10, { proceeds: 10, cost: 6, categoryId: 'a', categoryName: 'Alpha' }),
          ev(60, { proceeds: 10, cost: null, categoryId: 'b', categoryName: 'Bravo' }),
        ],
        0,
        100,
        2,
      );
      const bravo = report.byCategory.find((g) => g.id === 'b')!;
      // Bravo's revenue still shows in the breakdown — it just backs no margin.
      expect(bravo.proceeds).toBe(10);
      expect(bravo.costedProceeds).toBe(0);
      expect(bravo.margin).toBe(0);
      expect(report.buckets[1]!.proceeds).toBe(10);
      expect(report.buckets[1]!.margin).toBe(0);
      // The #400 property survives: the columns still re-add to the headline.
      expect(sum(report.byCategory.map((g) => g.margin))).toBe(report.margin);
      expect(sum(report.buckets.map((b) => b.margin))).toBe(report.margin);
    });

    it('reports no margin at all when nothing sold carried a cost', () => {
      const report = buildSalesReport([ev(10, { quantity: 3, proceeds: 25, cost: null })], 0, 100, 4);
      expect(report.proceeds).toBe(25);
      expect(report.costedProceeds).toBe(0);
      expect(report.cogs).toBe(0);
      // Not 25 at 100%: the app has no idea what this stock cost, so it claims no profit on it.
      expect(report.margin).toBe(0);
      expect(report.marginPct).toBe(0);
      expect(report.unitsWithoutCost).toBe(3);
    });
  });
});
