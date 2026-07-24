/**
 * Pure aggregation, bucketing & shaping for the §3 Reports & valuation screen
 * (inventory-depth Phase 61). Kept free of React, repositories, SQL and the DOM so
 * every calculation is unit-tested in isolation (Protocol Beta); `ReportRepository`
 * pulls the minimal raw rows from SQLite and hands them to these helpers, and the UI
 * formats the resulting DTOs with `useFormatters`.
 *
 * The reports are read-only projections over data already stored — there is no schema
 * change in this phase. Valuation honours a single internal "effective unit cost"
 * lookup ({@link effectiveUnitCost}) which delegates the cost-precedence rule to the
 * Phase-60 {@link resolveCostPrecedence} helper, so the "manual cost wins, else preferred
 * supplier cost" rule lives in exactly one place across the app.
 */
import { MS_PER_DAY } from '@/db/repositories/constants';
import { effectiveUnitCost as resolveCostPrecedence } from '@/features/inventory/supplier-cost';

import { inTimeWindow } from './window-membership';

// --- Effective unit cost (the single swap-point for cost precedence) -----------

/**
 * A minimal item shape for valuation — only the fields the cost/value maths needs.
 * Keeping it structural (not the full `Item`) lets the repository select a narrow
 * projection and keeps these helpers trivially testable.
 */
export interface ValuedUnit {
  /** Manual replacement cost per unit (`items.unit_cost`); null when unpriced. */
  readonly unitCost: number | null;
  /**
   * The preferred supplier part's cost per unit, resolved by `ReportRepository` from the
   * `supplier_parts` ledger (NULL/absent when no preferred part is marked or priced). It is
   * the fallback when there is no manual {@link ValuedUnit.unitCost}.
   */
  readonly preferredSupplierCost?: number | null;
}

/**
 * The effective per-unit cost used for valuation, isolated behind one function so callers
 * never re-implement cost precedence. The precedence rule itself — a manual `unitCost`
 * wins, else the preferred supplier cost, else unpriced — is owned by the Phase-60
 * {@link resolveCostPrecedence} helper (`@/features/inventory/supplier-cost`), which this
 * delegates to so there is a single source of truth across reporting and the item screens.
 * An unpriced item contributes `0` to valuation totals.
 */
export function effectiveUnitCost(unit: ValuedUnit): number {
  const resolved = resolveCostPrecedence(
    { unitCost: unit.unitCost },
    unit.preferredSupplierCost != null ? [{ unitCost: unit.preferredSupplierCost, isPreferred: true }] : [],
  );
  return resolved ?? 0;
}

// --- Inventory valuation -------------------------------------------------------

/** One named grouping of inventory value (a category or a location). */
export interface ValueGroup {
  /** Stable id of the group (category/location id), or null for the "ungrouped" bucket. */
  readonly id: string | null;
  /** Human-readable group name (e.g. a category or location name). */
  readonly name: string;
  /** Total value of stock in this group, in the base currency. */
  readonly value: number;
  /** Total units counted toward this group's value. */
  readonly quantity: number;
}

/** The complete inventory-valuation report (overall + two breakdowns). */
export interface InventoryValueReport {
  /** `SUM(quantity * effectiveUnitCost)` across all active, priced stock. */
  readonly totalValue: number;
  /** Total on-hand units across all valued items. */
  readonly totalQuantity: number;
  /** How many active items carried no usable cost (excluded from `totalValue`). */
  readonly unpricedItemCount: number;
  /** Value broken down by category, largest first; ungrouped last. */
  readonly byCategory: readonly ValueGroup[];
  /** Value broken down by stock location, largest first; ungrouped last. */
  readonly byLocation: readonly ValueGroup[];
}

/**
 * Aggregate statistics for a single location's contents (issue #458): the combined value of the
 * stock physically held there and a few headline counts, plus the value broken down by category.
 *
 * The figures read the per-location `item_stock` ledger valued by the *same* effective-unit-value
 * rule as {@link InventoryValueReport}'s location breakdown, so a location's total here equals its
 * row on the Reports "value by location" list. With {@link includesSubtree} the scope is the
 * location plus every descendant, so a room rolls up every shelf and drawer beneath it.
 */
export interface LocationStatsReport {
  /** Whether the figures include the location's descendant sub-locations. */
  readonly includesSubtree: boolean;
  /** How many locations the figures cover — 1 for the location alone, more with its subtree. */
  readonly locationCount: number;
  /** `SUM(quantity × effectiveUnitValue)` across the stock physically held here, base currency. */
  readonly totalValue: number;
  /** Total on-hand units held here. */
  readonly totalQuantity: number;
  /** Distinct active items with on-hand stock physically held here. */
  readonly distinctItemCount: number;
  /** How many of those distinct items carry no usable value (so are excluded from `totalValue`). */
  readonly unpricedItemCount: number;
  /**
   * Σ (item bounding-box volume × units held) over the items in scope that have all three
   * dimensions, in canonical **mm³** (issue #457/#458). An item missing any dimension adds
   * nothing — the same convention the location tree's volume-utilisation bar uses.
   */
  readonly usedVolume: number;
  /** Distinct items in scope with all three dimensions set (so contributing to `usedVolume`). */
  readonly measuredItemCount: number;
  /** Value of the held stock broken down by category, largest first; ungrouped last. */
  readonly byCategory: readonly ValueGroup[];
}

/**
 * Fallback label for a row with no category/location group.
 *
 * @internal Exported for unit tests only.
 */
export const UNGROUPED_LABEL = 'Ungrouped';

/**
 * One already-summed group as the database returns it (issue #170): the valuation totals
 * themselves are computed by `SUM(...) … GROUP BY` in SQL, so a report over a 100k-item
 * inventory transfers ~50 rows rather than every item row. Only the presentation rules —
 * naming the ungrouped bucket and ordering the groups — remain here.
 */
export interface ValueGroupTotals {
  readonly id: string | null;
  /** The group's name as stored; null for the ungrouped bucket (or a dangling reference). */
  readonly name: string | null;
  readonly value: number;
  readonly quantity: number;
}

/**
 * Label and order already-summed valuation {@link ValueGroupTotals}: a nameless group takes
 * the {@link UNGROUPED_LABEL}, and groups sort by value descending (name as the tiebreak)
 * with the null/ungrouped bucket forced last regardless of its value.
 */
export function sortValueGroups(groups: readonly ValueGroupTotals[]): ValueGroup[] {
  return groups
    .map((g) => ({ id: g.id, name: g.name ?? UNGROUPED_LABEL, value: g.value, quantity: g.quantity }))
    .sort((a, b) => {
      // Force the ungrouped bucket to the end regardless of its value.
      if (a.id === null && b.id !== null) return 1;
      if (b.id === null && a.id !== null) return -1;
      if (b.value !== a.value) return b.value - a.value;
      return a.name.localeCompare(b.name);
    });
}

// --- Consumption rate (from item_history negative deltas) ----------------------

/** A single consumed-quantity event drawn from `item_history`. */
export interface ConsumptionEvent {
  /** UNIX-ms of the ledger entry. */
  readonly createdAt: number;
  /** Net units consumed (a positive magnitude — already absolute). */
  readonly consumed: number;
}

/** The consumption-rate report over a trailing window. */
export interface ConsumptionRateReport {
  /** Start of the window (UNIX-ms, inclusive). */
  readonly windowStart: number;
  /** End of the window (UNIX-ms, exclusive) — typically "now". */
  readonly windowEnd: number;
  /** Whole days spanned by the window (≥ 1). */
  readonly windowDays: number;
  /** Total units consumed inside the window. */
  readonly totalConsumed: number;
  /** Mean units consumed per day across the window. */
  readonly perDay: number;
}

/**
 * Sum the consumed magnitudes that fall inside `[windowStart, windowEnd)` and derive the
 * mean daily rate. Events outside the window are ignored. `windowDays` is clamped to ≥ 1
 * so a sub-day window never divides by zero.
 */
export function summariseConsumption(
  events: readonly ConsumptionEvent[],
  windowStart: number,
  windowEnd: number,
): ConsumptionRateReport {
  const windowDays = Math.max(1, Math.round((windowEnd - windowStart) / MS_PER_DAY));
  let totalConsumed = 0;
  for (const event of events) {
    if (!inTimeWindow(event.createdAt, windowStart, windowEnd)) continue;
    if (event.consumed > 0) totalConsumed += event.consumed;
  }
  return {
    windowStart,
    windowEnd,
    windowDays,
    totalConsumed,
    perDay: totalConsumed / windowDays,
  };
}

// --- Stock movement over time buckets ------------------------------------------

/** A single ledger movement: a signed quantity change at an instant. */
export interface MovementEvent {
  readonly createdAt: number;
  /** Signed quantity delta (positive = in, negative = out). */
  readonly delta: number;
}

/** One time bucket of aggregated ins/outs. */
export interface MovementBucket {
  /** Bucket start (UNIX-ms, inclusive). */
  readonly start: number;
  /** Bucket end (UNIX-ms, exclusive). */
  readonly end: number;
  /** Total units moved in (sum of positive deltas) in this bucket. */
  readonly in: number;
  /** Total units moved out (absolute sum of negative deltas) in this bucket. */
  readonly out: number;
}

/** The stock-movement report: contiguous day-aligned buckets over the window. */
export interface MovementReport {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly buckets: readonly MovementBucket[];
  readonly totalIn: number;
  readonly totalOut: number;
}

/**
 * Bucket signed movements into `bucketCount` equal contiguous spans across
 * `[windowStart, windowEnd)`, summing positive deltas as `in` and the magnitude of
 * negative deltas as `out`. Events outside the window are dropped; an event exactly on
 * `windowEnd` is excluded (half-open). `bucketCount` is clamped to ≥ 1.
 */
export function bucketMovement(
  events: readonly MovementEvent[],
  windowStart: number,
  windowEnd: number,
  bucketCount: number,
): MovementReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const span = Math.max(1, windowEnd - windowStart);
  const width = span / count;
  const buckets: { start: number; end: number; in: number; out: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.round(windowStart + i * width);
    const end = i === count - 1 ? windowEnd : Math.round(windowStart + (i + 1) * width);
    buckets.push({ start, end, in: 0, out: 0 });
  }

  let totalIn = 0;
  let totalOut = 0;
  for (const event of events) {
    if (!inTimeWindow(event.createdAt, windowStart, windowEnd)) continue;
    const ratio = (event.createdAt - windowStart) / span;
    const index = Math.min(count - 1, Math.max(0, Math.floor(ratio * count)));
    const bucket = buckets[index];
    if (!bucket) continue;
    if (event.delta > 0) {
      bucket.in += event.delta;
      totalIn += event.delta;
    } else if (event.delta < 0) {
      bucket.out += -event.delta;
      totalOut += -event.delta;
    }
  }
  return { windowStart, windowEnd, buckets, totalIn, totalOut };
}

// --- Dead stock (no movement in N days) ----------------------------------------

/** A candidate item for the dead-stock report, with its last-movement instant. */
export interface DeadStockCandidate {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitCost: number | null;
  readonly preferredSupplierCost?: number | null;
  /**
   * UNIX-ms of the item's most recent stock movement, or null when it has never moved
   * since creation (in which case `createdAt` stands in as the reference instant).
   */
  readonly lastMovedAt: number | null;
  readonly createdAt: number;
  /**
   * This item's own idle threshold in days, resolved from its location chain (issue #92).
   * Omitted ⇒ the report-level `sinceDays` applies. Only items the caller has already
   * confirmed are opted in reach here — the opt-in decision is not re-made in this seam.
   */
  readonly thresholdDays?: number;
}

/** A dead-stock line: an item idle since before the cutoff, with its tied-up value. */
export interface DeadStockLine {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  /** Days since the item last moved (or was created), as of `now`. */
  readonly idleDays: number;
  /** Capital tied up in the idle stock (`quantity * effectiveUnitCost`). */
  readonly value: number;
  /**
   * The idle threshold this line was judged against (issue #92) — the report-level
   * `sinceDays` unless a location overrode it. Surfaced so a row flagged at 365 days
   * doesn't look wrong next to a heading that says 90.
   */
  readonly thresholdDays: number;
}

/** The dead-stock report: idle lines (most idle first) plus the tied-up total. */
export interface DeadStockReport {
  readonly sinceDays: number;
  readonly lines: readonly DeadStockLine[];
  /** Total capital tied up in idle stock. */
  readonly totalValue: number;
  /**
   * How many items were **opted in and hold stock**, and were therefore actually judged
   * (issue #92) — whether or not they turned out to be idle. Lets the UI tell "nothing is
   * being watched" apart from "everything being watched is still moving", which an empty
   * `lines` alone can't say. Items with no stock are excluded, matching `lines`.
   */
  readonly consideredCount: number;
}

/**
 * Select items whose last movement (or creation, when never moved) is at or before their
 * cutoff — i.e. **no movement in N days**. The boundary is inclusive: an item idle for
 * *exactly* its threshold qualifies. Lines are sorted most-idle first; the tied-up value
 * uses {@link effectiveUnitCost}. Items with no on-hand stock are excluded (there is
 * nothing dead to report).
 *
 * Each candidate may carry its own {@link DeadStockCandidate.thresholdDays}, resolved from
 * its location chain (issue #92); `sinceDays` is the fallback for those that don't, and
 * the figure the report as a whole is labelled with. Because thresholds vary per line, the
 * cutoff is computed per candidate rather than once up front.
 */
export function selectDeadStock(
  candidates: readonly DeadStockCandidate[],
  sinceDays: number,
  now: number,
): DeadStockReport {
  const lines: DeadStockLine[] = [];
  let totalValue = 0;
  let consideredCount = 0;
  for (const candidate of candidates) {
    if (candidate.quantity <= 0) continue; // no stock ⇒ nothing dead to report
    consideredCount += 1;
    const thresholdDays = candidate.thresholdDays ?? sinceDays;
    const reference = candidate.lastMovedAt ?? candidate.createdAt;
    if (reference > now - thresholdDays * MS_PER_DAY) continue; // still live
    const idleDays = Math.max(0, Math.floor((now - reference) / MS_PER_DAY));
    const value = Math.max(0, candidate.quantity) * effectiveUnitCost(candidate);
    totalValue += value;
    lines.push({
      id: candidate.id,
      name: candidate.name,
      quantity: candidate.quantity,
      idleDays,
      value,
      thresholdDays,
    });
  }
  lines.sort((a, b) => (b.idleDays !== a.idleDays ? b.idleDays - a.idleDays : b.value - a.value));
  return { sinceDays, lines, totalValue, consideredCount };
}
