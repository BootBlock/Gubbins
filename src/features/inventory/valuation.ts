/**
 * Pure valuation seam (feature-gap G9 — manual current / market value).
 *
 * Sits *beside* `asset-lifecycle.ts` rather than folding into it: depreciation lowers a
 * *book* value to zero over the asset's term, whereas a manual current value is an independent
 * mark-to-market that can move up or down. This module owns two things and nothing else —
 * no React, no repository, no SQL, no DOM — so both are exhaustively unit-testable in
 * isolation (same "logic out of glue" seam as `asset-lifecycle.ts`, `reorder-policy.ts`,
 * `price-history.ts`):
 *
 *  1. {@link effectiveUnitValue} — the override precedence: a manual current value **wins**
 *     over the depreciated/replacement cost when set, else the cost stands. This is the single
 *     rule the insurance schedule (G1) and the valuation reports both value each line through.
 *  2. {@link buildRevaluationSeries} — folds the append-only revaluation log into the trend
 *     primitives the item-detail surface renders (first/latest/min/max, absolute + percentage
 *     change, direction, sparkline series), mirroring `buildPriceSeries`.
 */
import type { Revaluation } from '@/db/repositories';

/**
 * The effective per-unit value used for valuation: the **manual current value wins when set**,
 * otherwise the supplied replacement cost stands. The replacement cost is computed by the
 * caller through the existing `effectiveUnitCost` seam (`@/features/reports/reports`) and
 * passed in, so this module stays free of the cost-precedence import (and any import cycle).
 *
 * A `currentValue` of `null`/`undefined` — or a non-finite/negative value that should never
 * reach here (the DB CHECK + `normaliseCurrentValue` guarantee ≥ 0) — falls back to the
 * replacement cost. A `currentValue` of `0` is a deliberate "worth nothing" mark and wins.
 */
export function effectiveUnitValue(currentValue: number | null | undefined, replacementCost: number): number {
  if (currentValue != null && Number.isFinite(currentValue) && currentValue >= 0) {
    return currentValue;
  }
  return replacementCost;
}

/** Direction of a value movement (a rise is welcome for an appreciating asset). */
export type ValueDirection = 'up' | 'down' | 'flat' | 'none';

/** The absolute + percentage change between two values, with a direction. */
export interface ValueChange {
  /** `to − from`. */
  readonly abs: number;
  /** Percentage change `from → to`, or null when `from` is 0 (no meaningful ratio). */
  readonly pct: number | null;
  readonly direction: ValueDirection;
}

/**
 * Describe the change from one value to another: the absolute delta, the percentage change
 * (null when `from` is 0 — no meaningful ratio, never a divide-by-zero), and the direction.
 * Powers both the first→latest trend and the "vs. purchase price" comparison.
 */
export function describeValueChange(from: number, to: number): ValueChange {
  const abs = to - from;
  const pct = from === 0 ? null : (abs / from) * 100;
  const direction: ValueDirection = abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat';
  return { abs, pct, direction };
}

export interface RevaluationSeries {
  /** The points sorted ascending by `revaluedAt` (oldest → newest). */
  readonly points: readonly Revaluation[];
  readonly count: number;
  /** The oldest point, or null when the log is empty. */
  readonly first: Revaluation | null;
  /** The newest point, or null when the log is empty. */
  readonly latest: Revaluation | null;
  readonly min: number | null;
  readonly max: number | null;
  /** `latest − first` value, or null when fewer than two points. */
  readonly changeAbs: number | null;
  /** Percentage change first→latest, or null when first is 0 or fewer than two points. */
  readonly changePct: number | null;
  readonly direction: ValueDirection;
}

/**
 * Fold raw revaluation points (in any order) into a chronological series + trend stats. An
 * empty log yields an empty series with `direction: 'none'`; a single point has no change
 * (`direction: 'flat'`, null change). The percentage change is null when the first value is 0
 * (no meaningful ratio) rather than dividing by zero. Ties on `revaluedAt` keep a stable order
 * (older `createdAt` first), so first/latest are deterministic. Mirrors `buildPriceSeries`.
 */
export function buildRevaluationSeries(entries: readonly Revaluation[]): RevaluationSeries {
  const points = [...entries].sort((a, b) => a.revaluedAt - b.revaluedAt || a.createdAt - b.createdAt);
  const count = points.length;
  if (count === 0) {
    return {
      points,
      count: 0,
      first: null,
      latest: null,
      min: null,
      max: null,
      changeAbs: null,
      changePct: null,
      direction: 'none',
    };
  }

  const first = points[0]!;
  const latest = points[count - 1]!;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (count === 1) {
    return { points, count, first, latest, min, max, changeAbs: null, changePct: null, direction: 'flat' };
  }

  const change = describeValueChange(first.value, latest.value);
  return {
    points,
    count,
    first,
    latest,
    min,
    max,
    changeAbs: change.abs,
    changePct: change.pct,
    direction: change.direction,
  };
}
