/**
 * Pure price-series maths for the supplier price-history surface (Phase 81).
 *
 * The repository stores one {@link SupplierPartPriceHistoryEntry} per genuine `unit_cost`
 * change. This module turns those raw points into the trend primitives the UI renders — a
 * chronological series, first/latest/min/max, the absolute and percentage change, a
 * direction, and a normalised sparkline polyline — keeping that logic out of the component
 * so it unit-tests directly (mirrors `describeHistoryEntry` / `buildSpendReport`). It never
 * touches the DOM, a clock or React. The percentage change is divide-by-zero-safe.
 */
import type { SupplierPartPriceHistoryEntry } from '@/db/repositories';

export type PriceDirection = 'up' | 'down' | 'flat' | 'none';

export interface PriceSeries {
  /** The points sorted ascending by `recordedAt` (oldest → newest). */
  readonly points: readonly SupplierPartPriceHistoryEntry[];
  readonly count: number;
  /** The oldest point, or null when the series is empty. */
  readonly first: SupplierPartPriceHistoryEntry | null;
  /** The newest point, or null when the series is empty. */
  readonly latest: SupplierPartPriceHistoryEntry | null;
  readonly min: number | null;
  readonly max: number | null;
  /** `latest − first` cost, or null when fewer than two points. */
  readonly changeAbs: number | null;
  /** Percentage change first→latest, or null when first is 0 or fewer than two points. */
  readonly changePct: number | null;
  readonly direction: PriceDirection;
}

/**
 * Fold raw price points (in any order) into a chronological series + trend stats. An empty
 * input yields an empty series with `direction: 'none'`; a single point has no change
 * (`direction: 'flat'`, null change). The percentage change is null when the first cost is
 * 0 (no meaningful ratio) rather than dividing by zero.
 */
export function buildPriceSeries(
  entries: readonly SupplierPartPriceHistoryEntry[],
): PriceSeries {
  const points = [...entries].sort((a, b) => a.recordedAt - b.recordedAt);
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
  const costs = points.map((p) => p.unitCost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);

  if (count === 1) {
    return { points, count, first, latest, min, max, changeAbs: null, changePct: null, direction: 'flat' };
  }

  const changeAbs = latest.unitCost - first.unitCost;
  const changePct = first.unitCost === 0 ? null : (changeAbs / first.unitCost) * 100;
  const direction: PriceDirection = changeAbs > 0 ? 'up' : changeAbs < 0 ? 'down' : 'flat';
  return { points, count, first, latest, min, max, changeAbs, changePct, direction };
}

/**
 * A normalised SVG polyline `points` string for a sparkline of the given values, oldest →
 * newest, scaled into the `width × height` box (y inverted so a higher cost is higher on
 * screen). A flat or single-value series renders as a mid-height line. Returns an empty
 * string for no values. Pure — no DOM.
 */
export function sparklinePolyline(
  values: readonly number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) return '';
  if (values.length === 1) {
    const mid = height / 2;
    return `0,${round(mid)} ${round(width)},${round(mid)}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const stepX = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = i * stepX;
      // No spread → mid-line; otherwise invert so the max sits at the top (y=0).
      const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

/** Round to 2 dp for compact, stable SVG coordinate output. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
