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
 *
 * **Amounts accumulate raw and are quantised once, at the boundary** (issue #288), and every
 * breakdown re-adds to its headline (issue #400). Each column — buckets, by-source, by-supplier,
 * by-category — is *apportioned* to the grand total through `apportionMoney` rather than rounded
 * row by row, so the figures sum to the total printed above them instead of drifting up to half a
 * minor unit per row adrift (invisible at 2dp, a whole unit under a 0-decimal currency). Shares
 * stay ratios of the raw totals — a fraction is not an amount.
 *
 * **One currency only** (issue #285). Every amount folded in here is assumed to be denominated in
 * the user's base currency; the caller is responsible for excluding anything that is not. Gubbins
 * holds no exchange rates, so adding a $500 order to a £500 one would produce a £1,000 total that
 * is simply wrong — the same refusal `inBaseCurrencySql` already makes for valuation (issue #284).
 * {@link SpendReport.excludedForeignCurrency} carries the count that was left out, so the omission
 * can be shown rather than silently understating the spend.
 */
import { MONEY_DECIMALS, apportionMoney, roundMoney } from '@/lib/money';

import { inTimeWindow } from './window-membership';

/** The three spend sources, each composed from data already stored. */
export type SpendSource = 'PURCHASE_ORDER' | 'PROJECT_EXPENSE' | 'ACQUISITION';

/**
 * Fixed display order for the by-source breakdown.
 *
 * @internal Exported for unit tests only.
 */
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
  /**
   * Canonical supplier id, or null when the source carries none (project expenses /
   * acquisitions). This is what by-supplier totals group on: grouping on the *name* used to
   * split one supplier's spend across every spelling of it (issue #384), and would still
   * re-key the group if a supplier were renamed.
   */
  readonly supplierId: string | null;
  /** Supplier display name, paired with {@link supplierId}. */
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
  /** Stable id of the group (supplier id / category id), or null for the catch-all bucket. */
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
  /**
   * How many in-window purchase orders were left out because they are priced in a currency other
   * than the base one (issue #285). `0` when nothing was excluded — including when the base
   * currency is unknown, since no exclusion can be decided in that case.
   */
  readonly excludedForeignCurrency: number;
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
 * **Window membership.** Only events inside the shared forward window {@link inTimeWindow}
 * (`windowStart <= instant < windowEnd`) are counted; an event exactly on `windowEnd` is excluded.
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
 *
 * **`excludedForeignCurrency`** is passed straight through to the report (clamped to a
 * non-negative integer). It is a count the caller has already decided — this seam never sees the
 * excluded rows, precisely because they must not reach any total.
 *
 * @param decimals Places every published amount is quantised to — the reporting currency's
 * **minor unit**, not a flat 2dp (issue #292). A yen has no minor unit and a Bahraini dinar has
 * three, so a hard-coded 2 invents precision a JPY total cannot hold and discards a digit a BHD
 * total genuinely has. The caller resolves this from the base currency
 * (`BaseRepository.moneyDecimals()`); it defaults to {@link MONEY_DECIMALS} so a caller that has
 * no currency to hand — and every existing test — behaves exactly as before.
 */
export function buildSpendReport(
  events: readonly SpendEvent[],
  windowStart: number,
  windowEnd: number,
  bucketCount: number,
  excludedForeignCurrency = 0,
  decimals: number = MONEY_DECIMALS,
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
  const supplierTotals = new Map<string | null, { name: string; total: number }>();
  const categoryTotals = new Map<string | null, { name: string; total: number }>();

  let total = 0;
  let eventCount = 0;
  for (const event of events) {
    if (!inTimeWindow(event.instant, windowStart, windowEnd)) continue;
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

    // Keyed on the supplier id, exactly like categories below — the name is display data.
    const supplierKey = event.supplierId ?? null;
    const supplierEntry = supplierTotals.get(supplierKey);
    if (supplierEntry) supplierEntry.total += amount;
    else {
      supplierTotals.set(supplierKey, {
        name: supplierKey === null ? NO_SUPPLIER : (event.supplier ?? NO_SUPPLIER),
        total: amount,
      });
    }

    const catKey = event.categoryId ?? null;
    const catName = event.categoryName ?? UNCATEGORISED;
    const existing = categoryTotals.get(catKey);
    if (existing) existing.total += amount;
    else categoryTotals.set(catKey, { name: catKey === null ? UNCATEGORISED : catName, total: amount });
  }

  // Amounts accumulated raw above; the headline is quantised once, here at the boundary (issue
  // #288), and every breakdown is then apportioned *to that headline* (issue #400) rather than
  // rounded row by row, so each column sums to the grand total instead of drifting a unit apart.
  // Shares stay ratios of the raw totals — a fraction is not an amount.
  const grandTotal = roundMoney(total, decimals);

  const sourceRaw = SPEND_SOURCES.map((source) => sourceTotals.get(source) ?? 0);
  const sourceApportioned = apportionMoney(sourceRaw, grandTotal, decimals);
  const bySource: SpendSourceTotal[] = SPEND_SOURCES.map((source, i) => ({
    source,
    total: sourceApportioned[i]!,
    share: share(sourceRaw[i]!, total),
  }));

  const supplierEntries = [...supplierTotals.entries()];
  const supplierApportioned = apportionMoney(
    supplierEntries.map(([, v]) => v.total),
    grandTotal,
    decimals,
  );
  const bySupplier: SpendGroup[] = supplierEntries
    .map(([id, { name, total: groupTotal }], i) => ({
      id,
      name,
      total: supplierApportioned[i]!,
      share: share(groupTotal, total),
    }))
    .sort(byTotalThenName);

  const categoryEntries = [...categoryTotals.entries()];
  const categoryApportioned = apportionMoney(
    categoryEntries.map(([, v]) => v.total),
    grandTotal,
    decimals,
  );
  const byCategory: SpendGroup[] = categoryEntries
    .map(([id, { name, total: groupTotal }], i) => ({
      id,
      name,
      total: categoryApportioned[i]!,
      share: share(groupTotal, total),
    }))
    .sort(byTotalThenName);

  const bucketApportioned = apportionMoney(
    buckets.map((b) => b.total),
    grandTotal,
    decimals,
  );

  return {
    windowStart,
    windowEnd,
    total: grandTotal,
    eventCount,
    buckets: buckets.map((b, i) => ({
      start: b.start,
      end: b.end,
      total: bucketApportioned[i]!,
    })),
    bySource,
    bySupplier,
    byCategory,
    // `Math.floor(NaN)` is NaN and `Math.max(0, NaN)` is NaN, so a non-finite count would slip
    // through the clamp and then read as falsy at every consumer — losing the exclusion silently,
    // which is the one outcome this field exists to prevent.
    excludedForeignCurrency: Number.isFinite(excludedForeignCurrency)
      ? Math.max(0, Math.floor(excludedForeignCurrency))
      : 0,
  };
}

/** Stable group ordering: total descending, then name ascending (case-insensitive). */
function byTotalThenName(a: SpendGroup, b: SpendGroup): number {
  if (b.total !== a.total) return b.total - a.total;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
