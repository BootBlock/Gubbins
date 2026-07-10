import { describe, it, expect } from 'vitest';
import type { Revaluation } from '@/db/repositories';
import {
  buildRevaluationSeries,
  describeValueChange,
  effectiveUnitValue,
  type ValueDirection,
} from './valuation';

/** Build a minimal {@link Revaluation} for the pure-seam tests. */
function rev(overrides: Partial<Revaluation> & { value: number; revaluedAt: number }): Revaluation {
  return {
    id: `rev-${overrides.revaluedAt}-${overrides.value}`,
    itemId: 'item-1',
    note: null,
    createdAt: overrides.revaluedAt,
    updatedAt: overrides.revaluedAt,
    ...overrides,
  };
}

describe('effectiveUnitValue — manual current value override precedence', () => {
  it('prefers the manual current value over the replacement cost when set', () => {
    expect(effectiveUnitValue(250, 100)).toBe(250);
  });

  it('lets the manual value move value *down* below the replacement cost', () => {
    // Appreciation is not the only direction — a mark can also drop below book/replacement.
    expect(effectiveUnitValue(40, 100)).toBe(40);
  });

  it('falls back to the replacement cost when the manual value is null', () => {
    expect(effectiveUnitValue(null, 100)).toBe(100);
  });

  it('falls back to the replacement cost when the manual value is undefined', () => {
    expect(effectiveUnitValue(undefined, 100)).toBe(100);
  });

  it('treats a zero manual value as a deliberate "worth nothing" mark that wins', () => {
    expect(effectiveUnitValue(0, 100)).toBe(0);
  });

  it('ignores a non-finite or negative manual value and falls back to the cost', () => {
    expect(effectiveUnitValue(Number.NaN, 100)).toBe(100);
    expect(effectiveUnitValue(Number.POSITIVE_INFINITY, 100)).toBe(100);
    expect(effectiveUnitValue(-5, 100)).toBe(100);
  });

  it('returns the replacement cost verbatim (including 0) when no manual value is set', () => {
    expect(effectiveUnitValue(null, 0)).toBe(0);
  });
});

describe('describeValueChange', () => {
  it('reports an upward change with a positive percentage', () => {
    expect(describeValueChange(100, 150)).toEqual({ abs: 50, pct: 50, direction: 'up' });
  });

  it('reports a downward change with a negative percentage', () => {
    expect(describeValueChange(200, 150)).toEqual({ abs: -50, pct: -25, direction: 'down' });
  });

  it('reports a flat change with a zero percentage', () => {
    expect(describeValueChange(120, 120)).toEqual({ abs: 0, pct: 0, direction: 'flat' });
  });

  it('returns a null percentage (never a divide-by-zero) when the base is 0', () => {
    const change = describeValueChange(0, 80);
    expect(change.abs).toBe(80);
    expect(change.pct).toBeNull();
    expect(change.direction).toBe('up');
  });
});

describe('buildRevaluationSeries', () => {
  it('yields an empty series with direction "none" for an empty log', () => {
    const series = buildRevaluationSeries([]);
    expect(series.count).toBe(0);
    expect(series.first).toBeNull();
    expect(series.latest).toBeNull();
    expect(series.min).toBeNull();
    expect(series.max).toBeNull();
    expect(series.changeAbs).toBeNull();
    expect(series.changePct).toBeNull();
    expect(series.direction).toBe('none');
    expect(series.points).toEqual([]);
  });

  it('has no change and direction "flat" for a single point', () => {
    const series = buildRevaluationSeries([rev({ value: 500, revaluedAt: 1_000 })]);
    expect(series.count).toBe(1);
    expect(series.first?.value).toBe(500);
    expect(series.latest?.value).toBe(500);
    expect(series.min).toBe(500);
    expect(series.max).toBe(500);
    expect(series.changeAbs).toBeNull();
    expect(series.changePct).toBeNull();
    expect(series.direction).toBe('flat');
  });

  it('sorts points ascending by revaluedAt regardless of input order', () => {
    const series = buildRevaluationSeries([
      rev({ value: 300, revaluedAt: 3_000 }),
      rev({ value: 100, revaluedAt: 1_000 }),
      rev({ value: 200, revaluedAt: 2_000 }),
    ]);
    expect(series.points.map((p) => p.value)).toEqual([100, 200, 300]);
    expect(series.first?.value).toBe(100);
    expect(series.latest?.value).toBe(300);
  });

  it('summarises an appreciating log (value moving up)', () => {
    const series = buildRevaluationSeries([
      rev({ value: 100, revaluedAt: 1_000 }),
      rev({ value: 250, revaluedAt: 2_000 }),
    ]);
    expect(series.min).toBe(100);
    expect(series.max).toBe(250);
    expect(series.changeAbs).toBe(150);
    expect(series.changePct).toBe(150);
    expect(series.direction).toBe('up');
  });

  it('summarises a depreciating log (value moving down)', () => {
    const series = buildRevaluationSeries([
      rev({ value: 400, revaluedAt: 1_000 }),
      rev({ value: 300, revaluedAt: 2_000 }),
    ]);
    expect(series.changeAbs).toBe(-100);
    expect(series.changePct).toBe(-25);
    expect(series.direction).toBe('down');
  });

  it('tracks min/max across a non-monotonic log while measuring only first→latest', () => {
    const series = buildRevaluationSeries([
      rev({ value: 100, revaluedAt: 1_000 }),
      rev({ value: 500, revaluedAt: 2_000 }),
      rev({ value: 120, revaluedAt: 3_000 }),
    ]);
    expect(series.min).toBe(100);
    expect(series.max).toBe(500);
    // first→latest only: 100 → 120.
    expect(series.changeAbs).toBe(20);
    expect(series.changePct).toBe(20);
    expect(series.direction).toBe('up');
  });

  it('returns a null percentage when the first recorded value is 0', () => {
    const series = buildRevaluationSeries([
      rev({ value: 0, revaluedAt: 1_000 }),
      rev({ value: 90, revaluedAt: 2_000 }),
    ]);
    expect(series.changeAbs).toBe(90);
    expect(series.changePct).toBeNull();
    expect(series.direction).toBe('up');
  });

  it('breaks a revaluedAt tie deterministically by createdAt', () => {
    const series = buildRevaluationSeries([
      rev({ value: 200, revaluedAt: 5_000, createdAt: 5_200 }),
      rev({ value: 150, revaluedAt: 5_000, createdAt: 5_100 }),
    ]);
    expect(series.first?.value).toBe(150);
    expect(series.latest?.value).toBe(200);
    expect(series.direction).toBe('up');
  });

  it('does not mutate the input array', () => {
    const input = [rev({ value: 2, revaluedAt: 2_000 }), rev({ value: 1, revaluedAt: 1_000 })];
    const before = input.map((p) => p.value);
    buildRevaluationSeries(input);
    expect(input.map((p) => p.value)).toEqual(before);
  });
});

// A tiny exhaustiveness guard: every direction the series can report is a known token.
describe('ValueDirection tokens', () => {
  it('are the four expected values', () => {
    const all: ValueDirection[] = ['up', 'down', 'flat', 'none'];
    expect(new Set(all).size).toBe(4);
  });
});
