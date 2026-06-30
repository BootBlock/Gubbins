import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories';
import {
  bucketMovement,
  effectiveUnitCost,
  groupValuation,
  selectDeadStock,
  summariseConsumption,
  summariseValuation,
  UNGROUPED_LABEL,
} from './reports';

describe('effectiveUnitCost — the single cost-precedence seam', () => {
  it('uses the manual unitCost when present', () => {
    expect(effectiveUnitCost({ unitCost: 4.5 })).toBe(4.5);
  });

  it('falls back to a preferred-supplier cost when unitCost is null', () => {
    expect(effectiveUnitCost({ unitCost: null, preferredSupplierCost: 2 })).toBe(2);
  });

  it('treats an unpriced item as zero cost', () => {
    expect(effectiveUnitCost({ unitCost: null })).toBe(0);
    expect(effectiveUnitCost({ unitCost: NaN })).toBe(0);
  });
});

describe('groupValuation — valuation grouping', () => {
  it('merges rows by group id, multiplies qty × cost, and sorts by value desc', () => {
    const groups = groupValuation([
      { groupId: 'a', groupName: 'Capacitors', quantity: 10, unitCost: 2 }, // 20
      { groupId: 'a', groupName: 'Capacitors', quantity: 5, unitCost: 2 }, //  10 → 30 total
      { groupId: 'b', groupName: 'Resistors', quantity: 100, unitCost: 1 }, // 100
    ]);
    expect(groups.map((g) => [g.name, g.value, g.quantity])).toEqual([
      ['Resistors', 100, 100],
      ['Capacitors', 30, 15],
    ]);
  });

  it('counts unpriced quantity but contributes zero value, and forces ungrouped last', () => {
    const groups = groupValuation([
      { groupId: null, groupName: null, quantity: 3, unitCost: 50 }, // 150 but ungrouped
      { groupId: 'b', groupName: 'Resistors', quantity: 4, unitCost: null }, // unpriced → 0
      { groupId: 'a', groupName: 'Capacitors', quantity: 2, unitCost: 5 }, // 10
    ]);
    // Ungrouped is forced last even though its value (150) is the largest.
    expect(groups.map((g) => g.name)).toEqual(['Capacitors', 'Resistors', UNGROUPED_LABEL]);
    const resistors = groups.find((g) => g.id === 'b');
    expect(resistors).toMatchObject({ value: 0, quantity: 4 });
  });
});

describe('summariseValuation — headline totals', () => {
  it('totals value/quantity and counts unpriced items', () => {
    const summary = summariseValuation([
      { quantity: 10, unitCost: 2 }, // 20
      { quantity: 5, unitCost: null }, // unpriced
      { quantity: 3, unitCost: 0 }, // zero cost → counts as unpriced
    ]);
    expect(summary).toEqual({ totalValue: 20, totalQuantity: 18, unpricedItemCount: 2 });
  });
});

describe('summariseConsumption — windowed consumption rate', () => {
  const end = 100 * MS_PER_DAY;
  const start = end - 10 * MS_PER_DAY;

  it('sums consumed magnitudes inside the half-open window and derives per-day', () => {
    const report = summariseConsumption(
      [
        { createdAt: start - MS_PER_DAY, consumed: 999 }, // before window → ignored
        { createdAt: start, consumed: 30 }, // inclusive start
        { createdAt: start + 5 * MS_PER_DAY, consumed: 20 },
        { createdAt: end, consumed: 999 }, // exclusive end → ignored
      ],
      start,
      end,
    );
    expect(report.windowDays).toBe(10);
    expect(report.totalConsumed).toBe(50);
    expect(report.perDay).toBe(5);
  });

  it('clamps the window to at least one day to avoid divide-by-zero', () => {
    const report = summariseConsumption([{ createdAt: start, consumed: 4 }], start, start + 1000);
    expect(report.windowDays).toBe(1);
    expect(report.perDay).toBe(4);
  });
});

describe('bucketMovement — ins/outs over time buckets', () => {
  const start = 0;
  const end = 4 * MS_PER_DAY;

  it('buckets signed deltas into contiguous spans and totals ins/outs', () => {
    const report = bucketMovement(
      [
        { createdAt: 0, delta: 10 }, // bucket 0 in
        { createdAt: MS_PER_DAY - 1, delta: -3 }, // bucket 0 out
        { createdAt: 2 * MS_PER_DAY, delta: 5 }, // bucket 2 in
        { createdAt: 3 * MS_PER_DAY, delta: -2 }, // bucket 3 out
        { createdAt: end, delta: 100 }, // exactly windowEnd → excluded
      ],
      start,
      end,
      4,
    );
    expect(report.buckets).toHaveLength(4);
    expect(report.buckets[0]).toMatchObject({ in: 10, out: 3 });
    expect(report.buckets[1]).toMatchObject({ in: 0, out: 0 });
    expect(report.buckets[2]).toMatchObject({ in: 5, out: 0 });
    expect(report.buckets[3]).toMatchObject({ in: 0, out: 2 });
    expect(report.totalIn).toBe(15);
    expect(report.totalOut).toBe(5);
  });

  it('clamps bucketCount to at least one', () => {
    const report = bucketMovement([{ createdAt: MS_PER_DAY, delta: 7 }], start, end, 0);
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toMatchObject({ in: 7, out: 0 });
  });
});

describe('selectDeadStock — dead-stock boundary', () => {
  const now = 100 * MS_PER_DAY;

  it('includes items idle for exactly the cutoff (inclusive boundary) and excludes fresher ones', () => {
    const report = selectDeadStock(
      [
        // exactly 30 days idle → qualifies (boundary inclusive)
        { id: 'a', name: 'Idle', quantity: 4, unitCost: 5, lastMovedAt: now - 30 * MS_PER_DAY, createdAt: 0 },
        // 29 days idle → still live, excluded
        { id: 'b', name: 'Fresh', quantity: 9, unitCost: 1, lastMovedAt: now - 29 * MS_PER_DAY, createdAt: 0 },
        // never moved; created 90 days ago → uses createdAt → qualifies
        { id: 'c', name: 'Never', quantity: 2, unitCost: 10, lastMovedAt: null, createdAt: now - 90 * MS_PER_DAY },
        // zero stock → excluded regardless of idleness
        { id: 'd', name: 'Empty', quantity: 0, unitCost: 5, lastMovedAt: 0, createdAt: 0 },
      ],
      30,
      now,
    );
    expect(report.lines.map((l) => l.id)).toEqual(['c', 'a']); // most idle first
    expect(report.lines[0]).toMatchObject({ idleDays: 90, value: 20 });
    expect(report.lines[1]).toMatchObject({ idleDays: 30, value: 20 });
    expect(report.totalValue).toBe(40);
  });
});
