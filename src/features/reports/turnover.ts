/**
 * Pure inventory-turnover analytics for the §3 Reports screen (Phase 74 "advanced
 * analytics"). Like its sibling {@link ./reports}, this module is kept free of React,
 * repositories, SQL, the DOM and the clock so every calculation is unit-tested in
 * isolation (Protocol Beta); a repository pulls the minimal raw rows from SQLite and
 * hands them to {@link summariseTurnover}, and the UI formats the resulting DTOs with
 * `useFormatters`.
 *
 * **Turnover** is the classic inventory ratio — cost of goods consumed over a window
 * divided by the average value held on hand during that window. A high turnover means
 * stock cycles quickly; a low turnover means capital sits idle. Its reciprocal,
 * **days-on-hand**, expresses the same thing as "how many days of cover the average
 * holding represents at the consumption rate".
 *
 * Because Gubbins stores no historical value snapshots, the window-start quantity is
 * **reconstructed** from the current quantity by reversing the net ledger movement over
 * the window: `startQty = currentQty − netQtyDelta`. The average on-hand quantity is then
 * the simple mean of the two endpoints `(startQty + currentQty) / 2`, valued at the
 * item's {@link effectiveUnitCost}. This is an approximation (it assumes roughly linear
 * movement across the window) but it needs no extra storage and uses only data the ledger
 * already holds.
 *
 * Valuation reuses the single cost-precedence seam {@link effectiveUnitCost} from
 * {@link ./reports} so the "manual cost wins, else preferred supplier cost, else unpriced"
 * rule lives in exactly one place; an unpriced item contributes `0` to every value total.
 */
import { effectiveUnitCost, type ValuedUnit } from './reports';

/**
 * A raw turnover input row: one item's current holding plus its consumed and net ledger
 * movement over the window. Structural (not the full `Item`) so the repository can select
 * a narrow projection and the maths stays trivially testable. Extends {@link ValuedUnit}
 * so {@link effectiveUnitCost} resolves the per-unit cost from the same precedence rule.
 */
export interface TurnoverInput extends ValuedUnit {
  /** Stable item id. */
  readonly id: string;
  /** Human-readable item name (used for the tie-break sort). */
  readonly name: string;
  /** On-hand quantity now (`items.quantity`). */
  readonly currentQty: number;
  /**
   * Units consumed over the window — the positive magnitude of outflow, i.e.
   * `-SUM(MIN(quantity_delta, 0))` from `item_history`. Always a non-negative count.
   */
  readonly consumedUnits: number;
  /**
   * Signed net quantity change over the window — `SUM(quantity_delta)`. Used to reverse
   * the ledger and reconstruct the window-start quantity; positive for a net inflow,
   * negative for a net outflow.
   */
  readonly netQtyDelta: number;
}

/** One item's turnover line over the window. */
export interface TurnoverLine {
  readonly id: string;
  readonly name: string;
  /** Cost of goods consumed = `max(0, consumedUnits) * effectiveUnitCost`. */
  readonly cogs: number;
  /** Average on-hand value over the window = `avgQty * effectiveUnitCost`. */
  readonly avgValue: number;
  /** `cogs / avgValue`, or `null` when there is no average value to turn over. */
  readonly turnover: number | null;
  /** `windowDays * avgValue / cogs`, or `null` when nothing was consumed. */
  readonly daysOnHand: number | null;
}

/** The full turnover report: per-item lines plus portfolio-wide totals and ratios. */
export interface TurnoverReport {
  /** Whole days spanned by the window (≥ 1). */
  readonly windowDays: number;
  /** Per-item lines, turnover descending with `null` turnover last (see {@link summariseTurnover}). */
  readonly lines: readonly TurnoverLine[];
  /** `Σ cogs` across all lines. */
  readonly totalCogs: number;
  /** `Σ avgValue` across all lines. */
  readonly totalAvgValue: number;
  /** Portfolio turnover `totalCogs / totalAvgValue`, or `null` when there is no value held. */
  readonly turnover: number | null;
  /** Portfolio days-on-hand `windowDays * totalAvgValue / totalCogs`, or `null` when nothing consumed. */
  readonly daysOnHand: number | null;
}

/**
 * Guarded ratio `numerator / denominator` that never emits `NaN` or `Infinity`: returns
 * `null` whenever the denominator is not strictly positive (or is non-finite). Centralising
 * the guard keeps every division in this module safe and consistent.
 */
function safeRatio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return numerator / denominator;
}

/**
 * Compute the inventory-turnover report from per-item current/consumed/net-movement rows.
 *
 * For each item: the per-unit cost comes from {@link effectiveUnitCost}; the cost of goods
 * consumed is `max(0, consumedUnits) * cost`. The window-start quantity is reconstructed by
 * reversing the net movement (`startQty = max(0, currentQty − netQtyDelta)`, clamped so a
 * larger reported outflow than current stock can never produce a negative start), and the
 * average on-hand value is the mean of the two endpoints valued at `cost`. Turnover and
 * days-on-hand are each computed with the same {@link safeRatio} guard, so an item with no
 * value held (unpriced, or zero stock at both ends) yields `null` turnover, and an item
 * that consumed nothing yields `null` days-on-hand — never a divide-by-zero.
 *
 * The portfolio totals sum each line's `cogs` and `avgValue`, and the portfolio turnover
 * and days-on-hand are derived from those totals with the identical guarded division.
 *
 * `windowDays` is clamped to ≥ 1 (`Math.max(1, Math.round(windowDays))`) so a sub-day or
 * non-integer window never distorts the days-on-hand scaling or divides by zero.
 *
 * Lines are sorted by turnover descending with `null` turnover forced last; ties break by
 * `cogs` descending, then by `name` (locale-aware) so the order is stable and meaningful.
 */
export function summariseTurnover(items: readonly TurnoverInput[], windowDays: number): TurnoverReport {
  const days = Math.max(1, Math.round(windowDays));
  const lines: TurnoverLine[] = [];
  let totalCogs = 0;
  let totalAvgValue = 0;

  for (const item of items) {
    const cost = effectiveUnitCost(item);
    const cogs = Math.max(0, item.consumedUnits) * cost;
    // Reverse the net ledger movement to recover the window-start holding, clamped to ≥ 0.
    const startQty = Math.max(0, item.currentQty - item.netQtyDelta);
    const avgQty = (startQty + item.currentQty) / 2;
    const avgValue = avgQty * cost;

    totalCogs += cogs;
    totalAvgValue += avgValue;

    lines.push({
      id: item.id,
      name: item.name,
      cogs,
      avgValue,
      turnover: safeRatio(cogs, avgValue),
      daysOnHand: cogs > 0 ? safeRatio(days * avgValue, cogs) : null,
    });
  }

  lines.sort((a, b) => {
    // turnover descending, with null turnover forced to the end.
    if (a.turnover === null && b.turnover !== null) return 1;
    if (b.turnover === null && a.turnover !== null) return -1;
    if (a.turnover !== null && b.turnover !== null && a.turnover !== b.turnover) {
      return b.turnover - a.turnover;
    }
    // Tie-break: larger cost-of-goods-consumed first, then name (locale-aware).
    if (a.cogs !== b.cogs) return b.cogs - a.cogs;
    return a.name.localeCompare(b.name);
  });

  return {
    windowDays: days,
    lines,
    totalCogs,
    totalAvgValue,
    turnover: safeRatio(totalCogs, totalAvgValue),
    daysOnHand: totalCogs > 0 ? safeRatio(days * totalAvgValue, totalCogs) : null,
  };
}
