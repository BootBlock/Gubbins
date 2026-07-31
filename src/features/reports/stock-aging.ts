/**
 * Pure stock-aging bucketing for the §3 Reports & valuation screen (advanced-analytics
 * Phase 74). Like its sibling {@link file://./reports.ts}, this is kept free of React,
 * repositories, SQL and the DOM so every calculation is unit-tested in isolation
 * (Protocol Beta); `ReportRepository` pulls the minimal raw rows from SQLite — resolving
 * each item's most-recent inbound instant and reading `items.acquired_at` as a report instant
 * via {@link acquiredAtReportInstant} — and hands them to {@link bucketStockAging}, and the UI
 * formats the resulting DTO with `useFormatters`.
 *
 * The report is a read-only projection over data already stored. Valuation reuses the same
 * shared {@link stockValue} seam as the "Inventory value" headline — a manual `current_value`
 * wins, else the "effective unit cost" precedence (manual cost, else preferred supplier cost,
 * else unpriced → 0), and a gauge is valued from its contents and its cost per unit of measure
 * (issue #683) — so the two figures value the same stock identically (issue #397).
 */
import { MS_PER_DAY } from '@/db/repositories/constants';
import { utcDayToLocalDay } from '@/lib/calendar-days';

import { stockValue, valuedAmount, type ValuedStock } from './reports';

/** Default bucket boundaries (inclusive upper bounds, in days): 0–30 / 31–90 / 91–180 / 180+. */
const DEFAULT_BOUNDS: readonly number[] = [30, 90, 180];

/** En dash used in bucket labels (e.g. `'0–30 days'`), matching the app's typographic style. */
const EN_DASH = '–';

/**
 * A minimal item shape for stock aging — extends the {@link ValuedStock} valuation seam
 * with the three candidate reference instants. Kept structural (not the full `Item`) so the
 * repository selects a narrow projection and these helpers stay trivially testable.
 */
export interface AgingInput extends ValuedStock {
  /** Stable item id. */
  readonly id: string;
  /** Human-readable item name. */
  readonly name: string;
  /**
   * UNIX-ms of the most recent inbound (positive-quantity) movement, or null when the item
   * has had no inbound movement. The highest-precedence reference instant for age.
   */
  readonly lastInboundAt: number | null;
  /**
   * `items.acquired_at` (an ISO date/datetime TEXT column) as a report instant, or null when unset
   * or unparseable — produced by {@link acquiredAtReportInstant}, which re-anchors a date-only day to
   * the user's local midnight so its age is measured on the same wall-clock timeline as `now` (issue
   * #323). Used when there is no inbound movement.
   */
  readonly acquiredAtMs: number | null;
  /** UNIX-ms creation instant — the final fallback reference when nothing else is known. */
  readonly createdAt: number;
}

/** One age bucket of aggregated on-hand stock. */
export interface AgingBucket {
  /** Human-readable label, e.g. `'0–30 days'` or `'180+ days'`. */
  readonly label: string;
  /** Inclusive lower age bound, in days. */
  readonly minDays: number;
  /** Inclusive upper age bound in days; null for the open-ended oldest bucket. */
  readonly maxDays: number | null;
  /** Number of items falling in this bucket. */
  readonly itemCount: number;
  /** Total on-hand units in this bucket. */
  readonly quantity: number;
  /** Total value of stock in this bucket (`quantity * effectiveUnitValue`). */
  readonly value: number;
}

/** The complete stock-aging report: every bucket (zeroed when empty) plus the totals. */
export interface StockAgingReport {
  /** The reference instant the ages were computed against (UNIX-ms). */
  readonly now: number;
  /** All buckets in ascending age order; always present even when empty. */
  readonly buckets: readonly AgingBucket[];
  /** Total on-hand units across every counted item. */
  readonly totalQuantity: number;
  /** Total value across every counted item. */
  readonly totalValue: number;
}

/**
 * Parse an `items.acquired_at` TEXT value (an ISO date `YYYY-MM-DD` or datetime, or null)
 * to its UNIX-ms instant via {@link Date.parse}. Returns null when the input is null,
 * empty/whitespace, or unparseable (`Number.isNaN`). Kept pure and standalone so it is
 * unit-tested directly; the repository calls it and passes the result as
 * {@link AgingInput.acquiredAtMs}.
 */
export function parseAcquiredAt(text: string | null | undefined): number | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/** A bare ISO calendar date (`YYYY-MM-DD`), the form `items.acquired_at` is stored in. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant an `items.acquired_at` value should occupy on a **report** timeline anchored to the
 * user's wall clock — a stock age, or a spend window (issue #323).
 *
 * A bare `YYYY-MM-DD` names a calendar *day*, not an instant: {@link parseAcquiredAt} pins it to
 * midnight UTC (the storage convention, issue #320), which sits hours ahead of a local `now` east of
 * UTC — so a value dated "today" would be aged as negative (clamped to 0) or dropped from a `< now`
 * spend window until the local clock catches up. Re-anchoring a date-only value to local midnight of
 * the same day ({@link utcDayToLocalDay}) puts it on the same timeline the window and `now` use. A
 * value that already carries a time component is a genuine instant and is returned unchanged. Null,
 * empty or unparseable input yields null, exactly like {@link parseAcquiredAt}.
 */
export function acquiredAtReportInstant(text: string | null | undefined): number | null {
  const ms = parseAcquiredAt(text);
  if (ms === null) return null;
  // `ms !== null` guarantees `text` was a non-empty, parseable string.
  return DATE_ONLY.test((text as string).trim()) ? utcDayToLocalDay(ms) : ms;
}

/**
 * Build the inclusive [min, max] bucket boundaries from a list of upper bounds. `bounds`
 * is sorted ascending and de-duplicated defensively (so an unsorted or repeated input still
 * yields contiguous, non-overlapping ranges); an empty list falls back to {@link DEFAULT_BOUNDS}.
 * N bounds produce N+1 buckets: each upper bound closes a range, and a final open-ended
 * (`maxDays: null`) bucket catches everything older.
 */
function makeBuckets(bounds: readonly number[]): {
  minDays: number;
  maxDays: number | null;
  label: string;
}[] {
  const cleaned = [...new Set(bounds.filter((b) => b > 0))].sort((a, b) => a - b);
  const effective = cleaned.length > 0 ? cleaned : [...DEFAULT_BOUNDS];

  const ranges: { minDays: number; maxDays: number | null; label: string }[] = [];
  let min = 0;
  for (const max of effective) {
    ranges.push({ minDays: min, maxDays: max, label: `${min}${EN_DASH}${max} days` });
    min = max + 1;
  }
  // Final open-ended bucket: everything older than the last bound.
  const last = effective[effective.length - 1] as number;
  ranges.push({ minDays: last + 1, maxDays: null, label: `${last}+ days` });
  return ranges;
}

/**
 * Bucket on-hand stock by the age of its newest inbound. Each item's reference instant is
 * `lastInboundAt ?? acquiredAtMs ?? createdAt` (the newest inbound movement wins, else the
 * acquisition date, else creation), and its age is
 * `Math.max(0, Math.floor((now − reference) / MS_PER_DAY))` so a future reference clamps to
 * age 0. Only items with `quantity > 0` are counted (nothing on hand = nothing to age);
 * each contributes `Math.max(0, quantity) * effectiveUnitValue(currentValuePerUnit, effectiveUnitCost(item))`
 * to its bucket's value — a manual current value wins over the cost, exactly as the "Inventory
 * value" headline values the same stock, so the two figures never disagree (issue #397).
 *
 * Buckets derive from `bounds` (inclusive upper bounds, default `[30, 90, 180]` → ranges
 * `0–30`, `31–90`, `91–180`, `180+`); N bounds yield N+1 buckets. An item lands in the first
 * bucket whose `maxDays` (inclusive) it does not exceed; the oldest bucket is open-ended.
 * `bounds` is sorted + de-duplicated defensively and an empty list falls back to the default.
 * Every bucket is always present in the report even when empty (zeroed).
 */
export function bucketStockAging(
  items: readonly AgingInput[],
  now: number,
  bounds: readonly number[] = DEFAULT_BOUNDS,
): StockAgingReport {
  const ranges = makeBuckets(bounds);
  const buckets = ranges.map((r) => ({ ...r, itemCount: 0, quantity: 0, value: 0 }));

  let totalQuantity = 0;
  let totalValue = 0;
  for (const item of items) {
    // A gauge is aged on the material it holds, not its (always-zero) count (issue #683).
    if (valuedAmount(item) <= 0) continue;
    const reference = item.lastInboundAt ?? item.acquiredAtMs ?? item.createdAt;
    const ageDays = Math.max(0, Math.floor((now - reference) / MS_PER_DAY));

    // First bucket whose inclusive upper bound the age does not exceed; the final
    // open-ended bucket (maxDays === null) catches everything older.
    const bucket =
      buckets.find((b) => b.maxDays === null || ageDays <= b.maxDays) ??
      (buckets[buckets.length - 1] as (typeof buckets)[number]);

    // A gauge contributes value but no *units*: its contents are grams or litres, and adding
    // those to a count of screws would make the bucket's quantity a number of nothing (#683).
    const qty = item.gauge ? 0 : Math.max(0, item.quantity);
    const value = stockValue(item);
    bucket.itemCount += 1;
    bucket.quantity += qty;
    bucket.value += value;
    totalQuantity += qty;
    totalValue += value;
  }

  return { now, buckets, totalQuantity, totalValue };
}
