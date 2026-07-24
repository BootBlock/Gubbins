import { describe, it, expect } from 'vitest';
import { buildSpendReport, SPEND_SOURCES, type SpendEvent } from './spend-analytics';

/**
 * Terse event builder with sensible defaults. Totals group on `supplierId` (issue #384), so
 * unless a case supplies one explicitly it is derived from the display name — one id per
 * distinct name, which is what a canonical supplier list guarantees anyway.
 */
function ev(instant: number, amount: number, over: Partial<SpendEvent> = {}): SpendEvent {
  const supplier = over.supplier ?? null;
  return {
    instant,
    amount,
    source: 'PURCHASE_ORDER',
    supplier,
    supplierId: supplier === null ? null : `sup-${supplier.toLowerCase()}`,
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
    expect(report.excludedForeignCurrency).toBe(0);
  });

  it('passes the caller-decided foreign-currency exclusion count through (issue #285)', () => {
    // The seam never sees the excluded rows — that is the point — so it only carries the count,
    // normalised to a non-negative integer so a bad caller cannot publish a nonsense figure.
    expect(buildSpendReport([ev(5, 10)], 0, 100, 5, 3).excludedForeignCurrency).toBe(3);
    expect(buildSpendReport([ev(5, 10)], 0, 100, 5).excludedForeignCurrency).toBe(0);
    expect(buildSpendReport([ev(5, 10)], 0, 100, 5, -2).excludedForeignCurrency).toBe(0);
    expect(buildSpendReport([ev(5, 10)], 0, 100, 5, 2.7).excludedForeignCurrency).toBe(2);
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

  it('totals a supplier by identity, not by the name on each event (issue #384)', () => {
    // Spend used to be keyed on the supplier name string, so one supplier recorded under two
    // spellings appeared as two rows splitting its true total. Identity keeps it one row.
    const report = buildSpendReport(
      [
        ev(10, 100, { supplierId: 'sup-rs', supplier: 'RS Components' }),
        ev(20, 40, { supplierId: 'sup-rs', supplier: 'RS-Components' }),
      ],
      0,
      100,
      2,
    );
    expect(report.bySupplier).toHaveLength(1);
    expect(report.bySupplier[0]).toMatchObject({ id: 'sup-rs', total: 140 });
  });

  it('keeps two distinct suppliers apart even when they share a name', () => {
    const report = buildSpendReport(
      [
        ev(10, 100, { supplierId: 'sup-a', supplier: 'Acme' }),
        ev(20, 40, { supplierId: 'sup-b', supplier: 'Acme' }),
      ],
      0,
      100,
      2,
    );
    expect(report.bySupplier.map((g) => g.id)).toEqual(['sup-a', 'sup-b']);
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

  // Issue #292: the scale is the currency's minor unit, not a flat 2dp.
  describe('currency minor unit', () => {
    it('quantises every published amount to whole units for a 0-decimal currency (JPY)', () => {
      const report = buildSpendReport(
        [
          ev(10, 100.5, { supplier: 'RS', categoryId: 'c1', categoryName: 'Resistors' }),
          ev(60, 200.25, { supplier: 'Mouser', categoryId: 'c2', categoryName: 'Caps' }),
        ],
        0,
        100,
        2,
        0, // excludedForeignCurrency
        0, // decimals — JPY
      );
      // Raw 300.75 → whole yen, half away from zero; a JPY total is never written with a fraction.
      expect(report.total).toBe(301);
      expect(report.buckets.map((b) => b.total)).toEqual([101, 200]);
      expect(report.bySupplier.map((g) => g.total)).toEqual([200, 101]);
      expect(report.byCategory.map((g) => g.total)).toEqual([200, 101]);
      expect(report.bySource.find((s) => s.source === 'PURCHASE_ORDER')!.total).toBe(301);
      // Shares stay ratios of the raw totals, unaffected by the coarser scale.
      expect(report.bySource.find((s) => s.source === 'PURCHASE_ORDER')!.share).toBe(1);
    });

    it('preserves the third digit for a 3-decimal currency (BHD)', () => {
      const report = buildSpendReport(
        [ev(10, 1.0005, { supplier: 'RS', categoryId: 'c1', categoryName: 'Resistors' })],
        0,
        100,
        1,
        0, // excludedForeignCurrency
        3, // decimals — BHD
      );
      // At the default 2dp this would publish 1.00 and discard a fils the amount genuinely has.
      expect(report.total).toBe(1.001);
      expect(report.buckets[0]!.total).toBe(1.001);
      expect(report.bySupplier[0]!.total).toBe(1.001);
      expect(report.byCategory[0]!.total).toBe(1.001);
    });
  });

  // Issue #400: every breakdown column re-adds to the grand total, apportioning the rounding
  // remainder rather than rounding each row on its own — visible under a 0-decimal currency, where
  // the per-row gap is a whole unit rather than a sub-penny.
  describe('breakdowns re-add to their headline (issue #400)', () => {
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

    it('makes every column sum to the grand total under a 0-decimal currency', () => {
      // Three ¥100.5 spends across distinct buckets, suppliers and categories. Rounded on their
      // own each row carries up to ¥101 → ¥303, but the raw total ¥301.5 publishes as ¥302.
      const report = buildSpendReport(
        [
          ev(10, 100.5, { supplier: 'Ay', categoryId: 'c1', categoryName: 'One' }),
          ev(40, 100.5, { supplier: 'Bee', categoryId: 'c2', categoryName: 'Two' }),
          ev(70, 100.5, { supplier: 'Cee', categoryId: 'c3', categoryName: 'Three' }),
        ],
        0,
        90,
        3,
        0, // excludedForeignCurrency
        0, // JPY — whole units
      );
      expect(report.total).toBe(302); // raw 301.5 → 302
      expect(sum(report.buckets.map((b) => b.total))).toBe(report.total);
      expect(sum(report.bySupplier.map((g) => g.total))).toBe(report.total);
      expect(sum(report.byCategory.map((g) => g.total))).toBe(report.total);
      expect(sum(report.bySource.map((s) => s.total))).toBe(report.total);
      for (const b of report.buckets) expect(Number.isInteger(b.total)).toBe(true);
      for (const g of report.bySupplier) expect(Number.isInteger(g.total)).toBe(true);
    });
  });
});
