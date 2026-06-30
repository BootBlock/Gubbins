import { describe, it, expect } from 'vitest';

import { classifyAbc, type AbcInput } from './abc-analysis';

/** Convenience builder: an input with a flat per-unit manual cost. */
function input(id: string, name: string, consumedUnits: number, unitCost: number | null): AbcInput {
  return { id, name, consumedUnits, unitCost };
}

describe('classifyAbc', () => {
  it('returns all-zero tiers and zero total for empty input', () => {
    const report = classifyAbc([]);
    expect(report.lines).toEqual([]);
    expect(report.totalValue).toBe(0);
    for (const tier of ['A', 'B', 'C'] as const) {
      expect(report.tiers[tier]).toEqual({ tier, itemCount: 0, totalValue: 0, valueShare: 0 });
    }
    // Defaults survive into the echoed thresholds.
    expect(report.thresholds).toEqual({ aCutoff: 0.8, bCutoff: 0.95 });
  });

  it('classifies a canonical Pareto split into A/B/C', () => {
    // Dominant item (800) → A; two mid items (90 + 60 = 150) → B; long tail → C.
    // Total = 1000. Running shares: 0.80, 0.89, 0.95, then the tail past 0.95.
    const items: AbcInput[] = [
      input('dom', 'Dominant', 800, 1), // 800
      input('mid1', 'Mid one', 90, 1), //  90  -> cum 890 (0.89)
      input('mid2', 'Mid two', 60, 1), //  60  -> cum 950 (0.95)
      input('tail1', 'Tail one', 30, 1), // 30 -> cum 980 (0.98)
      input('tail2', 'Tail two', 20, 1), // 20 -> cum 1000 (1.00)
    ];
    const report = classifyAbc(items);

    expect(report.totalValue).toBe(1000);

    // Lines are value-descending.
    expect(report.lines.map((l) => l.id)).toEqual(['dom', 'mid1', 'mid2', 'tail1', 'tail2']);
    expect(report.lines.map((l) => l.tier)).toEqual(['A', 'B', 'B', 'C', 'C']);

    // Running cumulative shares are computed AFTER each item.
    expect(report.lines.map((l) => l.cumulativeShare)).toEqual([0.8, 0.89, 0.95, 0.98, 1]);

    // Tier roll-ups.
    expect(report.tiers.A).toEqual({ tier: 'A', itemCount: 1, totalValue: 800, valueShare: 0.8 });
    expect(report.tiers.B).toEqual({ tier: 'B', itemCount: 2, totalValue: 150, valueShare: 0.15 });
    expect(report.tiers.C).toEqual({ tier: 'C', itemCount: 2, totalValue: 50, valueShare: 0.05 });

    // Shares partition the whole.
    const shareSum =
      report.tiers.A.valueShare + report.tiers.B.valueShare + report.tiers.C.valueShare;
    expect(shareSum).toBeCloseTo(1, 10);
  });

  it('the item crossing a boundary belongs to the lower tier it pushes into', () => {
    // Two equal items of value 50 each, total 100, aCutoff 0.8.
    // After #1: share 0.5 (<=0.8) -> A. After #2: share 1.0 (>0.95) -> C.
    const report = classifyAbc([input('a', 'Alpha', 50, 1), input('b', 'Bravo', 50, 1)]);
    expect(report.lines.map((l) => l.tier)).toEqual(['A', 'C']);
  });

  it('makes every item tier C with no NaN when all values are zero', () => {
    const items: AbcInput[] = [
      input('a', 'Alpha', 0, 5), // zero consumption
      input('b', 'Bravo', 10, 0), // zero cost
    ];
    const report = classifyAbc(items);
    expect(report.totalValue).toBe(0);
    expect(report.lines.every((l) => l.tier === 'C')).toBe(true);
    expect(report.lines.every((l) => l.cumulativeShare === 0)).toBe(true);
    expect(report.lines.every((l) => Number.isFinite(l.annualValue))).toBe(true);
    for (const tier of ['A', 'B', 'C'] as const) {
      expect(report.tiers[tier].valueShare).toBe(0);
      expect(Number.isNaN(report.tiers[tier].valueShare)).toBe(false);
    }
    expect(report.tiers.C.itemCount).toBe(2);
  });

  it('makes every item tier C when all are unpriced (effective cost 0)', () => {
    const items: AbcInput[] = [
      { id: 'a', name: 'Alpha', consumedUnits: 100, unitCost: null },
      { id: 'b', name: 'Bravo', consumedUnits: 200, unitCost: null },
    ];
    const report = classifyAbc(items);
    expect(report.totalValue).toBe(0);
    expect(report.lines.every((l) => l.tier === 'C')).toBe(true);
  });

  it('puts a single priced item in tier A', () => {
    const report = classifyAbc([input('only', 'Only', 3, 4)]);
    expect(report.totalValue).toBe(12);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]?.tier).toBe('A');
    expect(report.lines[0]?.cumulativeShare).toBe(1);
    expect(report.tiers.A.itemCount).toBe(1);
    expect(report.tiers.A.valueShare).toBe(1);
  });

  it('orders exact-value ties deterministically by name', () => {
    // Same value; inserted out of name order, expect localeCompare order.
    const report = classifyAbc([
      input('z', 'Zulu', 10, 1),
      input('a', 'Alpha', 10, 1),
      input('m', 'Mike', 10, 1),
    ]);
    expect(report.lines.map((l) => l.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('forces a zero-value item to tier C even when ranked among priced ones', () => {
    const items: AbcInput[] = [
      input('big', 'Big', 1000, 1), // value 1000 -> A
      input('free', 'Free', 50, null), // unpriced -> value 0 -> C despite rank
    ];
    const report = classifyAbc(items);
    const free = report.lines.find((l) => l.id === 'free');
    expect(free?.annualValue).toBe(0);
    expect(free?.tier).toBe('C');
    // The unpriced line still cumulates to a share of 1 (no value added).
    expect(free?.cumulativeShare).toBe(1);
  });

  it('uses the preferred supplier cost when no manual unit cost is set', () => {
    const report = classifyAbc([
      { id: 's', name: 'Supplied', consumedUnits: 4, unitCost: null, preferredSupplierCost: 5 },
    ]);
    expect(report.totalValue).toBe(20);
    expect(report.lines[0]?.tier).toBe('A');
  });

  it('honours custom cutoffs to change the split', () => {
    const items: AbcInput[] = [
      input('a', 'Alpha', 60, 1), // cum 0.6
      input('b', 'Bravo', 30, 1), // cum 0.9
      input('c', 'Charlie', 10, 1), // cum 1.0
    ];
    // Tight A boundary: only the head is A, the next is B, the last is C.
    const tight = classifyAbc(items, { aCutoff: 0.6, bCutoff: 0.9 });
    expect(tight.lines.map((l) => l.tier)).toEqual(['A', 'B', 'C']);
    expect(tight.thresholds).toEqual({ aCutoff: 0.6, bCutoff: 0.9 });

    // Generous A boundary pulls more into A.
    const generous = classifyAbc(items, { aCutoff: 0.95 });
    expect(generous.lines.map((l) => l.tier)).toEqual(['A', 'A', 'C']);
  });

  it('clamps nonsensical cutoffs back into 0 < aCutoff <= bCutoff <= 1', () => {
    // aCutoff > bCutoff collapses the B band; both stay within range.
    const report = classifyAbc([input('a', 'Alpha', 1, 1)], { aCutoff: 5, bCutoff: -1 });
    expect(report.thresholds.aCutoff).toBeGreaterThan(0);
    expect(report.thresholds.bCutoff).toBeGreaterThan(0);
    expect(report.thresholds.aCutoff).toBeLessThanOrEqual(report.thresholds.bCutoff);
    expect(report.thresholds.bCutoff).toBeLessThanOrEqual(1);
  });

  it('clamps negative consumed units to zero', () => {
    const report = classifyAbc([input('neg', 'Neg', -5, 10)]);
    expect(report.totalValue).toBe(0);
    expect(report.lines[0]?.annualValue).toBe(0);
    expect(report.lines[0]?.tier).toBe('C');
  });
});
