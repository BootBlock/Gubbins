/**
 * Pure procurement / spend analytics (advanced analytics, Phase 79).
 *
 * Answers "**where did the money go, and when?**" — spend (cash out) over time, by source, by
 * supplier and by category. Kept free of React, repositories, SQL, the DOM and the clock so the
 * maths is unit-tested in isolation (Protocol Beta); `ReportRepository.spendAnalytics` pulls the
 * minimal raw rows from SQLite and hands them here, and the UI shapes the DTO with `useFormatters`.
 *
 * **Distinct from the Phase-74 valuation trend.** That reconstructs *inventory value* (what the
 * stock is worth) backward from the present; this sums *money spent* forward into time buckets.
 * Different question, different maths — they are complementary, never duplicative.
 *
 * **Three sources, each tagged.** Received purchase-order lines, manual project expenses, and item
 * acquisition prices. A single item bought through a PO can appear in two sources; rather than
 * silently de-duplicate (which would hide real cash movements), every event carries its `source` so
 * the by-source breakdown makes any overlap explicit and auditable.
 */

/** The three spend sources, each composed from data already stored. */
export type SpendSource = 'PURCHASE_ORDER' | 'PROJECT_EXPENSE' | 'ACQUISITION';

/** Fixed display order for the by-source breakdown. */
export const SPEND_SOURCES: readonly SpendSource[] = ['PURCHASE_ORDER', 'PROJECT_EXPENSE', 'ACQUISITION'];

/** Human-readable source labels (British English). */
export const SPEND_SOURCE_LABEL: Record<SpendSource, string> = {
  PURCHASE_ORDER: 'Purchase orders',
  PROJECT_EXPENSE: 'Project expenses',
  ACQUISITION: 'Asset acquisitions',
};

/** One spend event — a single cash outflow tagged with its dimensions. */
export interface SpendEvent {
  /** UNIX-ms the spend was incurred. */
  readonly instant: number;
  /** The amount spent (a positive money value; non-positive/non-finite events are ignored). */
  readonly amount: number;
  readonly source: SpendSource;
  /** Supplier name, or null when the source carries none (project expenses / acquisitions). */
  readonly supplier: string | null;
  /** Item-category id, or null when uncategorised / not applicable. */
  readonly categoryId: string | null;
  /** Item-category display name, paired with {@link categoryId}. */
  readonly categoryName: string | null;
}

/** One half-open `[start, end)` time bucket of total spend. */
export interface SpendBucket {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

/** A spend total for one source, with its share of the grand total (`0..1`). */
export interface SpendSourceTotal {
  readonly source: SpendSource;
  readonly total: number;
  readonly share: number;
}

/** A named spend grouping (a supplier or a category) with its share of the grand total. */
export interface SpendGroup {
  /** Stable id of the group (supplier name / category id), or null for the catch-all bucket. */
  readonly id: string | null;
  readonly name: string;
  readonly total: number;
  /** This group's share of the grand total (`0..1`; `0` when the total is 0). */
  readonly share: number;
}

/** The spend-analytics report over a trailing window. */
export interface SpendReport {
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Grand total spend in the window. */
  readonly total: number;
  /** Number of in-window spend events counted. */
  readonly eventCount: number;
  /** Equal half-open time buckets across `[windowStart, windowEnd)`, chronological. */
  readonly buckets: readonly SpendBucket[];
  /** Per-source totals, in {@link SPEND_SOURCES} order (a source with no spend reads as 0). */
  readonly bySource: readonly SpendSourceTotal[];
  /** Supplier totals, highest first (the "No supplier" catch-all carries `id: null`). */
  readonly bySupplier: readonly SpendGroup[];
  /** Category totals, highest first (the "Uncategorised" catch-all carries `id: null`). */
  readonly byCategory: readonly SpendGroup[];
}

/** Share guard: a part's fraction of the total, or 0 when the total is 0 (mirrors abc-analysis). */
function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** Display name for the "no supplier" catch-all group. */
const NO_SUPPLIER = 'No supplier';
/** Display name for the "uncategorised" catch-all group. */
const UNCATEGORISED = 'Uncategorised';

/**
 * Fold spend events into a windowed report: a chronological bucket series plus by-source,
 * by-supplier and by-category breakdowns.
 *
 * **Window membership (half-open, mirrors {@link bucketMovement}).** Only events with
 * `windowStart <= instant < windowEnd` are counted; an event exactly on `windowEnd` is excluded.
 * Events with a non-finite or non-positive `amount` are ignored (a refund/zero is not "spend").
 *
 * **Bucketing.** `bucketCount` equal half-open spans across the window (clamped to `>= 1`); the
 * final bucket's `end` is pinned to `windowEnd`. An event's bucket is
 * `floor((instant − windowStart) / span × count)`, clamped to the last index.
 *
 * **Breakdowns.** Supplier/category groups are sorted by total descending, then name ascending for
 * a stable order; a null supplier/category collapses into a single catch-all group. `bySource`
 * always lists all three sources in {@link SPEND_SOURCES} order (0 when none). Every `share` uses a
 * divide-by-zero-safe guard.
 */
export function buildSpendReport(
  events: readonly SpendEvent[],
  windowStart: number,
  windowEnd: number,
  bucketCount: number,
): SpendReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const span = Math.max(1, windowEnd - windowStart);
  const width = span / count;

  const buckets: { start: number; end: number; total: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.round(windowStart + i * width);
    const end = i === count - 1 ? windowEnd : Math.round(windowStart + (i + 1) * width);
    buckets.push({ start, end, total: 0 });
  }

  const sourceTotals = new Map<SpendSource, number>();
  const supplierTotals = new Map<string | null, number>();
  const categoryTotals = new Map<string | null, { name: string; total: number }>();

  let total = 0;
  let eventCount = 0;
  for (const event of events) {
    if (event.instant < windowStart || event.instant >= windowEnd) continue;
    if (!Number.isFinite(event.amount) || event.amount <= 0) continue;

    const amount = event.amount;
    total += amount;
    eventCount += 1;

    const index = Math.min(
      count - 1,
      Math.max(0, Math.floor(((event.instant - windowStart) / span) * count)),
    );
    buckets[index]!.total += amount;

    sourceTotals.set(event.source, (sourceTotals.get(event.source) ?? 0) + amount);

    const supplierKey = event.supplier ?? null;
    supplierTotals.set(supplierKey, (supplierTotals.get(supplierKey) ?? 0) + amount);

    const catKey = event.categoryId ?? null;
    const catName = event.categoryName ?? UNCATEGORISED;
    const existing = categoryTotals.get(catKey);
    if (existing) existing.total += amount;
    else categoryTotals.set(catKey, { name: catKey === null ? UNCATEGORISED : catName, total: amount });
  }

  const bySource: SpendSourceTotal[] = SPEND_SOURCES.map((source) => {
    const sourceTotal = sourceTotals.get(source) ?? 0;
    return { source, total: sourceTotal, share: share(sourceTotal, total) };
  });

  const bySupplier: SpendGroup[] = [...supplierTotals.entries()]
    .map(([id, groupTotal]) => ({
      id,
      name: id ?? NO_SUPPLIER,
      total: groupTotal,
      share: share(groupTotal, total),
    }))
    .sort(byTotalThenName);

  const byCategory: SpendGroup[] = [...categoryTotals.entries()]
    .map(([id, { name, total: groupTotal }]) => ({
      id,
      name,
      total: groupTotal,
      share: share(groupTotal, total),
    }))
    .sort(byTotalThenName);

  return { windowStart, windowEnd, total, eventCount, buckets, bySource, bySupplier, byCategory };
}

/** Stable group ordering: total descending, then name ascending (case-insensitive). */
function byTotalThenName(a: SpendGroup, b: SpendGroup): number {
  if (b.total !== a.total) return b.total - a.total;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
