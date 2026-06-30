/**
 * Pure aggregation, bucketing & shaping for the §3 Reports & valuation screen
 * (inventory-depth Phase 61). Kept free of React, repositories, SQL and the DOM so
 * every calculation is unit-tested in isolation (Protocol Beta); `ReportRepository`
 * pulls the minimal raw rows from SQLite and hands them to these helpers, and the UI
 * formats the resulting DTOs with `useFormatters`.
 *
 * The reports are read-only projections over data already stored — there is no schema
 * change in this phase. Valuation honours a single internal "effective unit cost"
 * lookup ({@link effectiveUnitCost}) so a later phase can swap in the preferred-supplier
 * cost helper without touching the aggregations.
 */
import { MS_PER_DAY } from '@/db/repositories/constants';

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
   * Preferred-supplier cost per unit, when a later phase wires one in. Absent today
   * (Phase 60 runs in parallel and is not in this tree), so it is optional and the
   * lookup simply falls through to {@link ValuedUnit.unitCost}.
   */
  readonly preferredSupplierCost?: number | null;
}

/**
 * The effective per-unit cost used for valuation, isolated behind one function so the
 * precedence rule lives in exactly one place. **Today:** the manual `unitCost`. The
 * plan: "Honour the Phase-60 cost-precedence helper if merged; otherwise `items.unitCost`."
 * The optional preferred-supplier cost is consulted as a fallback when present, so a
 * later phase can populate it without changing any caller.
 */
export function effectiveUnitCost(unit: ValuedUnit): number {
  if (unit.unitCost != null && Number.isFinite(unit.unitCost)) return unit.unitCost;
  const supplier = unit.preferredSupplierCost;
  if (supplier != null && Number.isFinite(supplier)) return supplier;
  return 0;
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

/** A raw valuation input row: one (item, group) contribution from the database. */
export interface ValuationRow {
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly quantity: number;
  readonly unitCost: number | null;
  readonly preferredSupplierCost?: number | null;
}

/** Fallback label for a row with no category/location group. */
export const UNGROUPED_LABEL = 'Ungrouped';

/**
 * Roll raw `(group, quantity, cost)` rows into sorted {@link ValueGroup}s. Rows with the
 * same group id merge; an unpriced row contributes 0 value but still counts its quantity.
 * Groups are sorted by value descending, with the null/ungrouped bucket forced last.
 */
export function groupValuation(rows: readonly ValuationRow[]): ValueGroup[] {
  const map = new Map<string, ValueGroup>();
  for (const row of rows) {
    const key = row.groupId ?? ' ungrouped';
    const cost = effectiveUnitCost(row);
    const qty = Math.max(0, row.quantity);
    const value = qty * cost;
    const existing = map.get(key);
    if (existing) {
      map.set(key, { ...existing, value: existing.value + value, quantity: existing.quantity + qty });
    } else {
      map.set(key, { id: row.groupId, name: row.groupName ?? UNGROUPED_LABEL, value, quantity: qty });
    }
  }
  return [...map.values()].sort((a, b) => {
    // Force the ungrouped bucket to the end regardless of its value.
    if (a.id === null && b.id !== null) return 1;
    if (b.id === null && a.id !== null) return -1;
    if (b.value !== a.value) return b.value - a.value;
    return a.name.localeCompare(b.name);
  });
}

/** A raw item-level valuation row (one per active item) for the headline totals. */
export interface ItemValuationRow {
  readonly quantity: number;
  readonly unitCost: number | null;
  readonly preferredSupplierCost?: number | null;
}

/** Headline totals across every valued item (overall value, units, unpriced count). */
export function summariseValuation(items: readonly ItemValuationRow[]): {
  totalValue: number;
  totalQuantity: number;
  unpricedItemCount: number;
} {
  let totalValue = 0;
  let totalQuantity = 0;
  let unpricedItemCount = 0;
  for (const item of items) {
    const qty = Math.max(0, item.quantity);
    const cost = effectiveUnitCost(item);
    totalQuantity += qty;
    if (cost > 0) totalValue += qty * cost;
    else unpricedItemCount += 1;
  }
  return { totalValue, totalQuantity, unpricedItemCount };
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
    if (event.createdAt < windowStart || event.createdAt >= windowEnd) continue;
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
    if (event.createdAt < windowStart || event.createdAt >= windowEnd) continue;
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
}

/** The dead-stock report: idle lines (most idle first) plus the tied-up total. */
export interface DeadStockReport {
  readonly sinceDays: number;
  readonly lines: readonly DeadStockLine[];
  /** Total capital tied up in idle stock. */
  readonly totalValue: number;
}

/**
 * Select items whose last movement (or creation, when never moved) is at or before the
 * `now − sinceDays` cutoff — i.e. **no movement in N days**. The boundary is inclusive:
 * an item idle for *exactly* `sinceDays` qualifies. Lines are sorted most-idle first; the
 * tied-up value uses {@link effectiveUnitCost}. Items with no on-hand stock are excluded
 * (there is nothing dead to report).
 */
export function selectDeadStock(
  candidates: readonly DeadStockCandidate[],
  sinceDays: number,
  now: number,
): DeadStockReport {
  const cutoff = now - sinceDays * MS_PER_DAY;
  const lines: DeadStockLine[] = [];
  let totalValue = 0;
  for (const candidate of candidates) {
    if (candidate.quantity <= 0) continue;
    const reference = candidate.lastMovedAt ?? candidate.createdAt;
    if (reference > cutoff) continue; // moved more recently than the cutoff → still live
    const idleDays = Math.max(0, Math.floor((now - reference) / MS_PER_DAY));
    const value = Math.max(0, candidate.quantity) * effectiveUnitCost(candidate);
    totalValue += value;
    lines.push({
      id: candidate.id,
      name: candidate.name,
      quantity: candidate.quantity,
      idleDays,
      value,
    });
  }
  lines.sort((a, b) => (b.idleDays !== a.idleDays ? b.idleDays - a.idleDays : b.value - a.value));
  return { sinceDays, lines, totalValue };
}
