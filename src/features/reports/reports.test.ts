import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories';
import {
  bucketMovement,
  effectiveUnitCost,
  selectDeadStock,
  sortValueGroups,
  stockValue,
  summariseConsumption,
  UNGROUPED_LABEL,
  valuedAmount,
  valuedUnitValue,
  type ValuedStock,
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

  it('prefers the manual unitCost over a present preferred-supplier cost', () => {
    expect(effectiveUnitCost({ unitCost: 3, preferredSupplierCost: 99 })).toBe(3);
  });

  it('treats a negative cost as unset (the shared precedence helper rejects it)', () => {
    expect(effectiveUnitCost({ unitCost: -5, preferredSupplierCost: 2 })).toBe(2);
    expect(effectiveUnitCost({ unitCost: null, preferredSupplierCost: -1 })).toBe(0);
  });

  // Issue #688 put the depreciated purchase price *below* this seam, in `valuedUnitValue`, not
  // in it. The figures reading this one are costs — turnover's cost of goods, ABC's consumption
  // value, dead stock's tied-up capital — and a write-down refunds none of what stock cost.
  it('ignores a depreciated purchase price: a cost is not a book value (issue #688)', () => {
    expect(effectiveUnitCost({ unitCost: null, depreciatedPurchasePrice: 750 } as ValuedStock)).toBe(0);
  });
});

// Issue #688 — before this, an asset priced only by what it cost and how long it lasts was valued
// at 0 by every valuation report and by the printed insurance schedule, while the item editor
// showed it a book value and the wiki said that figure was what the reports used.
describe('valuedUnitValue — the depreciated purchase price as the last fallback', () => {
  const asset = { quantity: 1, unitCost: null } as const;

  it('falls back to the depreciated purchase price when nothing else prices the item', () => {
    expect(valuedUnitValue({ ...asset, depreciatedPurchasePrice: 750 })).toBe(750);
    expect(stockValue({ ...asset, quantity: 2, depreciatedPurchasePrice: 750 })).toBe(1500);
  });

  it('stays below a current value, a unit cost and a supplier cost', () => {
    expect(valuedUnitValue({ ...asset, currentValuePerUnit: 900, depreciatedPurchasePrice: 750 })).toBe(900);
    expect(valuedUnitValue({ ...asset, unitCost: 3, depreciatedPurchasePrice: 750 })).toBe(3);
    expect(valuedUnitValue({ ...asset, preferredSupplierCost: 2, depreciatedPurchasePrice: 750 })).toBe(2);
  });

  // A priced source that resolved to a real 0 is a price, and it stands: "worth nothing" and
  // "we do not know" are different facts, and only the second may reach the fallback.
  it('lets a deliberate zero price win over the depreciated value', () => {
    expect(valuedUnitValue({ ...asset, unitCost: 0, depreciatedPurchasePrice: 750 })).toBe(0);
    expect(valuedUnitValue({ ...asset, preferredSupplierCost: 0, depreciatedPurchasePrice: 750 })).toBe(0);
  });

  it('treats an unusable depreciated purchase price as unset', () => {
    expect(valuedUnitValue({ ...asset, depreciatedPurchasePrice: null })).toBe(0);
    expect(valuedUnitValue({ ...asset, depreciatedPurchasePrice: -1 })).toBe(0);
    expect(valuedUnitValue({ ...asset, depreciatedPurchasePrice: NaN })).toBe(0);
  });

  // A gauge holds a *measure*, so every per-countable-unit figure is wrong for it by whatever
  // the capacity happens to be — a purchase price no less than a unit cost (issue #683).
  it('never prices a gauge from a depreciated purchase price', () => {
    expect(
      valuedUnitValue({
        ...asset,
        quantity: 0,
        depreciatedPurchasePrice: 750,
        gauge: { netValue: 400, costPerUnitOfMeasure: null },
      }),
    ).toBe(0);
  });
});

// Issue #683 — a gauge is valued along a different axis: it holds a *measure*, so its
// `quantity` is always 0 and `quantity × unit cost` reported a full cylinder as a confident £0.
describe('stockValue — which amount, and which per-unit value', () => {
  const counted = { quantity: 4, unitCost: 2.5 } as const;
  const gauge = {
    quantity: 0,
    unitCost: null,
    gauge: { netValue: 400, costPerUnitOfMeasure: 0.025 },
  } as const;

  it('multiplies the count by the effective unit value for an ordinary item', () => {
    expect(valuedAmount(counted)).toBe(4);
    expect(valuedUnitValue(counted)).toBe(2.5);
    expect(stockValue(counted)).toBe(10);
  });

  it('multiplies a gauge’s contents by its cost per unit of measure', () => {
    expect(valuedAmount(gauge)).toBe(400);
    expect(valuedUnitValue(gauge)).toBe(0.025);
    expect(stockValue(gauge)).toBe(10);
  });

  it('never prices a gauge from a per-unit figure, however tempting', () => {
    // `unitCost`, a manual current value and a supplier quote all price one *countable* unit.
    // Reading any of them per gram would be wrong by whatever the capacity happens to be —
    // here, 1000× — so an unpriced gauge stays unpriced rather than becoming a wrong number.
    const spoolPriced = {
      quantity: 0,
      unitCost: 25,
      currentValuePerUnit: 30,
      preferredSupplierCost: 27,
      gauge: { netValue: 400, costPerUnitOfMeasure: null },
    };
    expect(valuedUnitValue(spoolPriced)).toBe(0);
    expect(stockValue(spoolPriced)).toBe(0);
  });

  it('floors a negative amount or price rather than subtracting from a total', () => {
    // Neither can be reached through the UI, but a sync merge writes columns directly.
    expect(valuedAmount({ quantity: -3, unitCost: 1 })).toBe(0);
    expect(
      valuedAmount({ quantity: 0, unitCost: null, gauge: { netValue: -5, costPerUnitOfMeasure: 1 } }),
    ).toBe(0);
    expect(
      valuedUnitValue({ quantity: 0, unitCost: null, gauge: { netValue: 5, costPerUnitOfMeasure: -2 } }),
    ).toBe(0);
  });

  it('keeps the ordinary precedence intact when there is no gauge', () => {
    expect(valuedUnitValue({ quantity: 1, unitCost: 10, currentValuePerUnit: 25 })).toBe(25);
    expect(valuedUnitValue({ quantity: 1, unitCost: null, preferredSupplierCost: 3 })).toBe(3);
    // A deliberate "worth nothing" mark still wins over the cost.
    expect(valuedUnitValue({ quantity: 1, unitCost: 8, currentValuePerUnit: 0 })).toBe(0);
  });
});

describe('sortValueGroups — ordering the SQL-summed groups', () => {
  it('sorts by value descending, breaking ties on the name', () => {
    const groups = sortValueGroups([
      { id: 'a', name: 'Capacitors', quantity: 15, value: 30 },
      { id: 'c', name: 'Batteries', quantity: 1, value: 100 },
      { id: 'b', name: 'Resistors', quantity: 100, value: 100 },
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Batteries', 'Resistors', 'Capacitors']);
  });

  it('labels the nameless bucket and forces it last whatever its value', () => {
    const groups = sortValueGroups([
      { id: null, name: null, quantity: 3, value: 150 },
      { id: 'b', name: 'Resistors', quantity: 4, value: 0 },
      { id: 'a', name: 'Capacitors', quantity: 2, value: 10 },
    ]);
    // Ungrouped is forced last even though its value (150) is the largest.
    expect(groups.map((g) => g.name)).toEqual(['Capacitors', 'Resistors', UNGROUPED_LABEL]);
    expect(groups.find((g) => g.id === 'b')).toMatchObject({ value: 0, quantity: 4 });
  });
});

describe('summariseConsumption — windowed consumption rate', () => {
  const end = 100 * MS_PER_DAY;
  const start = end - 10 * MS_PER_DAY;

  it('sums consumed magnitudes inside the half-open window and derives per-day', () => {
    const report = summariseConsumption(
      [
        { createdAt: start - MS_PER_DAY, unit: null, consumed: 999 }, // before window → ignored
        { createdAt: start, unit: null, consumed: 30 }, // inclusive start
        { createdAt: start + 5 * MS_PER_DAY, unit: null, consumed: 20 },
        { createdAt: end, unit: null, consumed: 999 }, // exclusive end → ignored
      ],
      start,
      end,
    );
    expect(report.windowDays).toBe(10);
    expect(report.lines).toEqual([{ unit: null, totalConsumed: 50, perDay: 5 }]);
  });

  it('clamps the window to at least one day to avoid divide-by-zero', () => {
    const report = summariseConsumption([{ createdAt: start, unit: null, consumed: 4 }], start, start + 1000);
    expect(report.windowDays).toBe(1);
    expect(report.lines[0]?.perDay).toBe(4);
  });

  it('never adds different units together — one line each, biggest first (issue #685)', () => {
    const report = summariseConsumption(
      [
        { createdAt: start, unit: 'g', consumed: 400 },
        { createdAt: start + MS_PER_DAY, unit: 'ml', consumed: 50 },
        { createdAt: start + 2 * MS_PER_DAY, unit: null, consumed: 6 }, // bare screws
        { createdAt: start + 3 * MS_PER_DAY, unit: 'g', consumed: 100 },
      ],
      start,
      end,
    );
    expect(report.lines).toEqual([
      { unit: 'g', totalConsumed: 500, perDay: 50 },
      { unit: 'ml', totalConsumed: 50, perDay: 5 },
      { unit: null, totalConsumed: 6, perDay: 0.6 },
    ]);
  });

  it('folds one unit spelled differently into a single line, keeping the first spelling', () => {
    const report = summariseConsumption(
      [
        { createdAt: start, unit: 'Rolls', consumed: 2 },
        { createdAt: start, unit: ' rolls ', consumed: 3 },
        { createdAt: start, unit: '   ', consumed: 4 }, // blank → the unitless line
      ],
      start,
      end,
    );
    expect(report.lines).toEqual([
      { unit: 'Rolls', totalConsumed: 5, perDay: 0.5 },
      { unit: null, totalConsumed: 4, perDay: 0.4 },
    ]);
  });

  it('reports no lines at all when nothing was consumed in the window', () => {
    expect(summariseConsumption([], start, end).lines).toEqual([]);
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
        {
          id: 'a',
          name: 'Idle',
          quantity: 4,
          unitCost: 5,
          lastKnownMovementAt: now - 30 * MS_PER_DAY,
          createdAt: 0,
        },
        // 29 days idle → still live, excluded
        {
          id: 'b',
          name: 'Fresh',
          quantity: 9,
          unitCost: 1,
          lastKnownMovementAt: now - 29 * MS_PER_DAY,
          createdAt: 0,
        },
        // nothing on the ledger; created 90 days ago → uses createdAt → qualifies
        {
          id: 'c',
          name: 'Never',
          quantity: 2,
          unitCost: 10,
          lastKnownMovementAt: null,
          createdAt: now - 90 * MS_PER_DAY,
        },
        // zero stock → excluded regardless of idleness
        { id: 'd', name: 'Empty', quantity: 0, unitCost: 5, lastKnownMovementAt: 0, createdAt: 0 },
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
