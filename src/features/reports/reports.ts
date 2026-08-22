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
 * supplier cost" rule lives in exactly one place across the app. {@link valuedUnitValue} adds
 * one further fallback beneath it — the depreciated purchase price (issue #688) — which belongs
 * to *valuation* and deliberately not to the cost seam every consumption figure reads.
 */
import { MS_PER_DAY } from '@/db/repositories/constants';
import { addCalendarDays } from '@/lib/calendar-days';
import { foldName } from '@/lib/name-fold';
import { effectiveUnitCost as resolveCostPrecedence } from '@/features/inventory/supplier-cost';
import { effectiveUnitValue } from '@/features/inventory/valuation';

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
 * The effective per-unit **cost** used wherever a report asks what stock cost rather than what it
 * is worth, isolated behind one function so callers never re-implement cost precedence. The rule
 * itself — a manual `unitCost` wins, else the preferred supplier cost, else unpriced — is owned by
 * the Phase-60 {@link resolveCostPrecedence} helper (`@/features/inventory/supplier-cost`), which
 * this delegates to so there is a single source of truth across reporting and the item screens.
 * An unpriced item contributes `0` to valuation totals.
 *
 * It stops there. The depreciated purchase price added by issue #688 is a *valuation* fallback and
 * lives one level up, in {@link valuedUnitValue}, because the figures reading this function are
 * cost figures: turnover's cost of goods, ABC's annual consumption value, and dead stock's capital
 * tied up in stock that is not moving — "what it cost to acquire", which a write-down does not
 * refund any of. Quoting a residual book value in any of the three would be the same category
 * error as letting one price a purchase-order line.
 */
export function effectiveUnitCost(unit: ValuedUnit): number {
  return resolveUnitCost(unit) ?? 0;
}

/**
 * {@link effectiveUnitCost} before the unpriced case is collapsed onto `0`: the resolved per-unit
 * cost, or `null` when no source names one. The single point at which this module delegates to
 * {@link resolveCostPrecedence}.
 *
 * The distinction matters to exactly one caller — {@link valuationUnitCost}, which has a further
 * fallback below and so must tell a deliberate `0` price apart from no price at all. Every other
 * caller wants the `0`, which is why {@link effectiveUnitCost} remains the public seam.
 */
function resolveUnitCost(unit: ValuedUnit): number | null {
  return resolveCostPrecedence(
    { unitCost: unit.unitCost },
    unit.preferredSupplierCost != null ? [{ unitCost: unit.preferredSupplierCost, isPreferred: true }] : [],
  );
}

// --- What a valuation multiplies (issue #683) ----------------------------------

/**
 * A CONSUMABLE_GAUGE item's valuation inputs (issue #683) — the material actually in the
 * gauge and what one unit of measure of it costs.
 *
 * A gauge is priced along a different axis from everything else Gubbins values. Its
 * `items.quantity` is pinned at 0 (it tracks a *measure*, not a count of units), so the
 * ordinary `quantity × unit cost` product values a full argon cylinder at zero however
 * carefully it was priced — the defect this type exists to close.
 */
export interface GaugeValuation {
  /** Material currently held, in the item's unit of measure (`current_net_value`). */
  readonly netValue: number;
  /** Cost of one unit of measure, or `null` when the gauge is unpriced. */
  readonly costPerUnitOfMeasure: number | null;
}

/**
 * Everything the valuation rule needs to price one item's on-hand stock — the count-based
 * inputs every item carries, plus the gauge branch when it has one.
 *
 * `gauge` is present **only** for a CONSUMABLE_GAUGE item, and its presence is what selects
 * the axis: with it, value is `netValue × costPerUnitOfMeasure`; without it, the familiar
 * `quantity × effectiveUnitValue`. Callers therefore never test a tracking mode themselves —
 * they supply the gauge state (or don't) and let {@link valuedAmount} / {@link valuedUnitValue}
 * decide, which is what keeps the SQL twins in {@link ReportRepository} honest.
 */
export interface ValuedStock extends ValuedUnit {
  /** On-hand count. Ignored when {@link ValuedStock.gauge} is set (a gauge's is always 0). */
  readonly quantity: number;
  /** Manual per-unit mark-to-market value (`items.current_value`); wins over the cost. */
  readonly currentValuePerUnit?: number | null;
  /**
   * The item's **depreciated purchase price** per unit (issue #688) — `items.purchase_price` run
   * down its `depreciation_months` straight-line term as at the read's `now`, resolved by
   * `ReportRepository` in SQL so a whole-inventory total can still be summed by the database.
   * NULL/absent when the item carries no purchase price.
   *
   * It is the **last** thing {@link valuedUnitValue} tries, beneath every source
   * {@link resolveUnitCost} knows, because it answers a different question from those above it:
   * what this particular unit is reckoned to be worth today, rather than what replacing it would
   * cost. Anything that knows the replacement cost knows it better. Before this existed an asset
   * priced *only* by a purchase price and a term was valued at 0 by every valuation report and by
   * the printed insurance schedule, while the item editor showed a book value and the wiki said
   * that figure was what the reports used.
   *
   * It sits on {@link ValuedStock} rather than {@link ValuedUnit} deliberately: this is the shape
   * for "what is this stock **worth**", and the bare cost seam beneath it must stay a cost — see
   * {@link effectiveUnitCost}.
   *
   * `purchase_price` is read as a **per-unit** figure, like the `unitCost` and
   * `currentValuePerUnit` it stands in for — the whole precedence chain prices one unit and is
   * multiplied by the on-hand amount afterwards.
   */
  readonly depreciatedPurchasePrice?: number | null;
  /** Gauge state, for a CONSUMABLE_GAUGE item only; absent/null for every other mode. */
  readonly gauge?: GaugeValuation | null;
}

/**
 * The **amount** a valuation multiplies the per-unit value by: a gauge's material on hand,
 * else the on-hand count. Floored at 0 — neither a count nor a measure can be negative, and a
 * negative one would subtract from a total rather than simply not adding to it.
 */
export function valuedAmount(item: ValuedStock): number {
  return Math.max(0, item.gauge ? item.gauge.netValue : item.quantity);
}

/**
 * The replacement cost a **valuation** prices one unit at: every source {@link resolveUnitCost}
 * knows, and beneath them the {@link ValuedStock.depreciatedPurchasePrice} book value (issue
 * #688), for an asset nothing else prices. Only when that is absent too is the item genuinely
 * unpriced and worth `0` to a total.
 *
 * A priced source that resolved to a real `0` is a price and stands — `resolveUnitCost` returns
 * `null`, not `0`, for "no price", which is exactly what keeps "worth nothing" and "we do not
 * know" apart here.
 */
function valuationUnitCost(item: ValuedStock): number {
  const priced = resolveUnitCost(item);
  if (priced != null) return priced;
  const depreciated = item.depreciatedPurchasePrice;
  // The same usability test the priced sources get: a non-finite or negative figure names no price.
  return depreciated != null && Number.isFinite(depreciated) && depreciated >= 0 ? depreciated : 0;
}

/**
 * The **per-unit value** that amount is worth: for a gauge, the cost of one unit of measure
 * (0 when unpriced); otherwise the ordinary precedence — a manual current value wins, else the
 * {@link valuationUnitCost} replacement cost, else the depreciated book value beneath it.
 *
 * A gauge deliberately does **not** fall back to `unit_cost`, `current_value`, a supplier price or
 * a purchase price. All four price one *countable unit*, so applying any of them per gram would be
 * a confident wrong number — off by whatever the capacity happens to be. An unpriced gauge is
 * reported as unpriced instead, which is the same refusal the foreign-currency exclusion makes.
 */
export function valuedUnitValue(item: ValuedStock): number {
  if (item.gauge) return Math.max(0, item.gauge.costPerUnitOfMeasure ?? 0);
  return Math.max(0, effectiveUnitValue(item.currentValuePerUnit, valuationUnitCost(item)));
}

/** The value of one item's on-hand stock: {@link valuedAmount} × {@link valuedUnitValue}. */
export function stockValue(item: ValuedStock): number {
  return valuedAmount(item) * valuedUnitValue(item);
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
  /**
   * The consuming item's `unit_of_measure` as the user typed it, or `null` when it has none
   * (a bare count of things). This is the *dimension* the magnitude below is measured in, and
   * the only thing that makes two events addable.
   */
  readonly unit: string | null;
  /** Net amount consumed in that unit (a positive magnitude — already absolute). */
  readonly consumed: number;
}

/** One unit of measure's consumption over the window. */
export interface ConsumptionUnitLine {
  /**
   * The unit of measure, in the first spelling seen for it; `null` is the unitless line —
   * items that count bare things and name no unit.
   */
  readonly unit: string | null;
  /** Total consumed inside the window, **in this unit**. */
  readonly totalConsumed: number;
  /** Mean consumed per day across the window, in this unit. */
  readonly perDay: number;
}

/** The consumption-rate report over a trailing window. */
export interface ConsumptionRateReport {
  /** Start of the window (UNIX-ms, inclusive). */
  readonly windowStart: number;
  /** End of the window (UNIX-ms, exclusive) — typically "now". */
  readonly windowEnd: number;
  /** Whole days spanned by the window (≥ 1). */
  readonly windowDays: number;
  /**
   * One line per unit of measure, largest total first. There is deliberately **no** overall
   * total: the lines are incommensurable, so nothing may add them together (issue #685).
   */
  readonly lines: readonly ConsumptionUnitLine[];
}

/**
 * Bucket the consumed magnitudes that fall inside `[windowStart, windowEnd)` **by unit of
 * measure**, and derive each unit's mean daily rate. Events outside the window are ignored.
 * `windowDays` is clamped to ≥ 1 so a sub-day window never divides by zero.
 *
 * **Units are never added together** (issue #685). This used to return a single scalar, which
 * summed grams, millilitres and screws — a figure whose dimension was not merely unlabelled but
 * undefined, presented as both a total and a daily rate. Grouping is the same refusal the
 * valuation reads make of foreign-currency prices: report each dimension as itself rather than
 * convert (or, here, conflate) without a basis for it.
 *
 * Two events share a line when their units match under {@link foldName} — the app's natural-key
 * fold — so `g`, `G` and ` g ` are one unit, as they are everywhere else a user-typed name is an
 * identity. Anything else stays apart: `unit_of_measure` is free text with no conversion layer,
 * so `g` and `kg` are as distinct here as `g` and `screws`.
 */
export function summariseConsumption(
  events: readonly ConsumptionEvent[],
  windowStart: number,
  windowEnd: number,
): ConsumptionRateReport {
  const windowDays = Math.max(1, Math.round((windowEnd - windowStart) / MS_PER_DAY));
  // Keyed by the folded unit (`null` for the unitless line); the value keeps the first spelling
  // seen so the report shows the user's own capitalisation rather than a folded one.
  const byUnit = new Map<string | null, { unit: string | null; totalConsumed: number }>();
  for (const event of events) {
    if (!inTimeWindow(event.createdAt, windowStart, windowEnd)) continue;
    if (!(event.consumed > 0)) continue;
    const unit = event.unit?.trim() ? event.unit.trim() : null;
    const key = unit === null ? null : foldName(unit);
    const line = byUnit.get(key);
    if (line) line.totalConsumed += event.consumed;
    else byUnit.set(key, { unit, totalConsumed: event.consumed });
  }
  // Biggest total first, ties broken by unit for a stable order. Unlike `sortValueGroups` the
  // unitless line is *not* forced last: it is the ordinary case (most items name no unit), not
  // a residual bucket, so demoting it would bury the figure most users came for.
  const lines = [...byUnit.values()]
    .sort((a, b) => b.totalConsumed - a.totalConsumed || (a.unit ?? '').localeCompare(b.unit ?? ''))
    .map((line) => ({
      unit: line.unit,
      totalConsumed: line.totalConsumed,
      perDay: line.totalConsumed / windowDays,
    }));
  return { windowStart, windowEnd, windowDays, lines };
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
   * Gauge state for a CONSUMABLE_GAUGE item (issue #683), else absent. Its `quantity` is always
   * 0, so without this a full-but-idle cylinder would look like nothing to report.
   */
  readonly gauge?: GaugeValuation | null;
  /** The gauge's unit of measure, for the line's amount caption; absent for counted items. */
  readonly unitOfMeasure?: string | null;
  /**
   * UNIX-ms of the furthest forward the item's ledger accounts for: its most recent stock
   * movement, or the most recent point its Activity Log was cleared if that is later
   * (issue #686 — a clear deletes the movement rows, so it is where the record stops and
   * an idle age can honestly be measured from). Null when the ledger offers neither, in
   * which case `createdAt` stands in as the reference instant.
   */
  readonly lastKnownMovementAt: number | null;
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
  /**
   * For a gauge line (issue #683): the material it holds and its unit, so the row can read
   * "400 g" where a counted line reads a bare count. Null for every other tracking mode.
   */
  readonly measure: { readonly amount: number; readonly unit: string } | null;
  /** Days since the item last moved (or its log was cleared, or it was created), as of `now`. */
  readonly idleDays: number;
  /**
   * Capital tied up in the idle stock: the on-hand count × `effectiveUnitCost`, or for a gauge
   * its contents × its cost per unit of measure (issue #683).
   */
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
 * The reference instant an item is judged from is {@link DeadStockCandidate.lastKnownMovementAt}
 * — its last movement, or a later clear of its Activity Log — else its creation. Falling
 * straight through to creation would age an item by the whole span a clear erased (issue #686).
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
    // A gauge holds a measure rather than a count (issue #683), so what decides "holds stock"
    // — and what the tied-up capital is computed from — is its contents, not its quantity.
    const amount = valuedAmount(candidate);
    if (amount <= 0) continue; // no stock ⇒ nothing dead to report
    consideredCount += 1;
    const thresholdDays = candidate.thresholdDays ?? sinceDays;
    const reference = candidate.lastKnownMovementAt ?? candidate.createdAt;
    // Calendar-day idle threshold (issue #325): the "still live" cutoff is N calendar days back
    // from now, so it does not slip an hour across a DST change.
    if (reference > addCalendarDays(now, -thresholdDays)) continue; // still live
    const idleDays = Math.max(0, Math.floor((now - reference) / MS_PER_DAY));
    // Deliberately the *cost* seam, not `stockValue`: dead stock reports capital tied up in
    // stock that is not moving, which is what it cost to acquire — a mark-to-market revaluation
    // does not free up any of it. A gauge's cost per unit of measure is that same figure.
    const unitValue = candidate.gauge
      ? Math.max(0, candidate.gauge.costPerUnitOfMeasure ?? 0)
      : effectiveUnitCost(candidate);
    const value = amount * unitValue;
    totalValue += value;
    lines.push({
      id: candidate.id,
      name: candidate.name,
      quantity: candidate.gauge ? 0 : candidate.quantity,
      measure: candidate.gauge && candidate.unitOfMeasure ? { amount, unit: candidate.unitOfMeasure } : null,
      idleDays,
      value,
      thresholdDays,
    });
  }
  lines.sort((a, b) => (b.idleDays !== a.idleDays ? b.idleDays - a.idleDays : b.value - a.value));
  return { sinceDays, lines, totalValue, consideredCount };
}
