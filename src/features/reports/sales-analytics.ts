/**
 * Pure sales & disposal analytics (Sales & disposals capability).
 *
 * Answers "**what did I sell, what did it make, and what did I lose?**" — sale proceeds versus a
 * cost-of-goods snapshot (→ margin) plus written-off stock value, over a trailing window. Kept
 * free of React, repositories, SQL, the DOM and the clock so the maths is unit-tested in isolation
 * (Protocol Beta); `ReportRepository.salesAnalytics` pulls the minimal raw rows from the
 * `item_history` ledger and hands them here, and the UI shapes the DTO with `useFormatters`.
 *
 * **Cost basis is a snapshot, not a re-derivation.** Each `SOLD`/`WRITTEN_OFF` ledger row carried
 * the item's effective unit cost at the moment it left inventory (`metadata.unitCostAtSale`), so
 * the margin reflects the cost *as it was then*, immune to later price edits. A row whose cost was
 * unknown at the time contributes proceeds but no COGS; those units are counted separately
 * (`unitsWithoutCost`) so the UI can caveat the margin rather than silently overstate it.
 *
 * **Amounts accumulate raw and are quantised once, at the boundary** (issue #288) — every money
 * figure this module publishes goes through `@/lib/money`, rather than rounding per line and
 * summing rounded lines. Two consequences worth knowing:
 *
 *  - **A derived amount is derived from the published ones.** `margin` is published proceeds −
 *    published COGS at every level, so the amounts a reader sees side by side subtract correctly.
 *  - **A breakdown need not re-add to its headline.** Buckets and categories are each rounded on
 *    their own, so a column of them can sit up to half a penny per row away from the headline
 *    total. That is inherent to quantising parts and a whole independently; the headline is the
 *    accurate figure, and reconciling instead would mean apportioning the remainder across rows
 *    (which the printed insurance schedule does, because that document *is* read as a sum).
 *
 * Ratios (`share`, `marginPct`) are deliberately computed from the raw totals: they are
 * fractions, not amounts.
 */
import { MONEY_DECIMALS, roundMoney } from '@/lib/money';

/** The two outbound kinds this report folds together. */
export type SalesKind = 'SOLD' | 'WRITTEN_OFF';

/** One outbound event — a sale or a write-off — reduced to the figures the report needs. */
export interface SalesEvent {
  /** UNIX-ms the movement was recorded. */
  readonly instant: number;
  readonly kind: SalesKind;
  /** Units that left inventory (a positive count). */
  readonly quantity: number;
  /** Sale proceeds for the whole line (0 for a write-off). */
  readonly proceeds: number;
  /** Cost-of-goods for the whole line at the time it left, or null when the cost was unknown. */
  readonly cost: number | null;
  /** Item-category id, or null when uncategorised. */
  readonly categoryId: string | null;
  /** Item-category display name, paired with {@link categoryId}. */
  readonly categoryName: string | null;
}

/** One half-open `[start, end)` time bucket of sales performance. */
export interface SalesBucket {
  readonly start: number;
  readonly end: number;
  readonly proceeds: number;
  readonly cogs: number;
  /** Proceeds − COGS for the bucket (from costed sales only). */
  readonly margin: number;
}

/** A named grouping (a category) of sales, with its share of total proceeds. */
export interface SalesGroup {
  /** Stable id of the group (category id), or null for the "Uncategorised" catch-all. */
  readonly id: string | null;
  readonly name: string;
  readonly proceeds: number;
  readonly cogs: number;
  readonly margin: number;
  /** This group's share of total proceeds (`0..1`; `0` when proceeds are 0). */
  readonly share: number;
}

/** The sales-analytics report over a trailing window. */
export interface SalesReport {
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Total sale proceeds in the window. */
  readonly proceeds: number;
  /** Cost of goods sold (costed sales only). */
  readonly cogs: number;
  /** Gross margin: proceeds − COGS (costed sales only). */
  readonly margin: number;
  /** Margin as a fraction of proceeds (`0..1`; `0` when proceeds are 0). */
  readonly marginPct: number;
  /** Units sold in the window. */
  readonly unitsSold: number;
  /** Number of sale events counted. */
  readonly saleCount: number;
  /** Units sold whose cost was unknown at the time (excluded from COGS/margin). */
  readonly unitsWithoutCost: number;
  /** Cost value of stock written off in the window (a loss, not a sale). */
  readonly writeOffValue: number;
  /** Units written off in the window. */
  readonly writeOffUnits: number;
  /** Number of write-off events counted. */
  readonly writeOffCount: number;
  /** Equal half-open time buckets across `[windowStart, windowEnd)`, chronological. */
  readonly buckets: readonly SalesBucket[];
  /** Sales by item-category, highest proceeds first (the "Uncategorised" catch-all carries `id: null`). */
  readonly byCategory: readonly SalesGroup[];
}

/** Share guard: a part's fraction of the total, or 0 when the total is 0. */
function share(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** Display name for the "uncategorised" catch-all group. */
const UNCATEGORISED = 'Uncategorised';

/**
 * Fold sale/write-off events into a windowed report: headline proceeds/COGS/margin, units and
 * write-off totals, a chronological bucket series and a by-category breakdown.
 *
 * **Window membership (half-open, mirrors {@link buildSpendReport}).** Only events with
 * `windowStart <= instant < windowEnd` are counted; an event exactly on `windowEnd` is excluded.
 * Events with a non-positive `quantity` are ignored.
 *
 * **Bucketing.** `bucketCount` equal half-open spans across the window (clamped to `>= 1`); the
 * final bucket's `end` is pinned to `windowEnd`.
 *
 * **Costing.** A sale with a null `cost` contributes proceeds but no COGS, and its units are
 * tallied in `unitsWithoutCost`; margin is therefore always proceeds-of-costed-sales minus their
 * COGS, never overstated by unpriced stock. Write-offs never contribute proceeds or COGS — their
 * cost is surfaced separately as `writeOffValue`.
 *
 * @param decimals Places every published amount is quantised to — the reporting currency's
 * **minor unit**, not a flat 2dp (issue #292). A yen has no minor unit and a Bahraini dinar has
 * three, so a hard-coded 2 would book half a yen of margin the currency cannot express, then
 * display it rounded and disagree with itself. The caller resolves this from the base currency
 * (`BaseRepository.moneyDecimals()`); it defaults to {@link MONEY_DECIMALS} so a caller that has
 * no currency to hand — and every existing test — behaves exactly as before.
 */
export function buildSalesReport(
  events: readonly SalesEvent[],
  windowStart: number,
  windowEnd: number,
  bucketCount: number,
  decimals: number = MONEY_DECIMALS,
): SalesReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const span = Math.max(1, windowEnd - windowStart);
  const width = span / count;

  const buckets: { start: number; end: number; proceeds: number; cogs: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.round(windowStart + i * width);
    const end = i === count - 1 ? windowEnd : Math.round(windowStart + (i + 1) * width);
    buckets.push({ start, end, proceeds: 0, cogs: 0 });
  }

  const categoryTotals = new Map<string | null, { name: string; proceeds: number; cogs: number }>();

  let proceeds = 0;
  let cogs = 0;
  let unitsSold = 0;
  let saleCount = 0;
  let unitsWithoutCost = 0;
  let writeOffValue = 0;
  let writeOffUnits = 0;
  let writeOffCount = 0;

  for (const event of events) {
    if (event.instant < windowStart || event.instant >= windowEnd) continue;
    if (!Number.isFinite(event.quantity) || event.quantity <= 0) continue;

    if (event.kind === 'WRITTEN_OFF') {
      writeOffUnits += event.quantity;
      writeOffCount += 1;
      if (Number.isFinite(event.cost ?? NaN)) writeOffValue += event.cost!;
      continue;
    }

    // A sale.
    const lineProceeds = Number.isFinite(event.proceeds) ? Math.max(0, event.proceeds) : 0;
    const hasCost = event.cost !== null && Number.isFinite(event.cost);
    const lineCogs = hasCost ? event.cost! : 0;

    proceeds += lineProceeds;
    cogs += lineCogs;
    unitsSold += event.quantity;
    saleCount += 1;
    if (!hasCost) unitsWithoutCost += event.quantity;

    const index = Math.min(
      count - 1,
      Math.max(0, Math.floor(((event.instant - windowStart) / span) * count)),
    );
    buckets[index]!.proceeds += lineProceeds;
    buckets[index]!.cogs += lineCogs;

    const catKey = event.categoryId ?? null;
    const catName = catKey === null ? UNCATEGORISED : (event.categoryName ?? UNCATEGORISED);
    const existing = categoryTotals.get(catKey);
    if (existing) {
      existing.proceeds += lineProceeds;
      existing.cogs += lineCogs;
    } else {
      categoryTotals.set(catKey, { name: catName, proceeds: lineProceeds, cogs: lineCogs });
    }
  }

  // Every figure above accumulated at full precision; the published totals are quantised here,
  // once, at the boundary (issue #288). Rounding per line and summing rounded lines would make
  // three sales of 3 units at 0.10 total 0.8999999999999999 rather than 0.90.
  const totalProceeds = roundMoney(proceeds, decimals);
  const totalCogs = roundMoney(cogs, decimals);
  // Margin is derived from the two figures the report *publishes*, not from the raw difference,
  // so the three amounts a reader sees side by side actually subtract. Taking `roundMoney(raw
  // proceeds − raw cogs)` instead would reintroduce the very defect this seam removes: proceeds
  // 0.005 and cost 0.004 publish as 0.01 and 0.00, which no reader can reconcile with a 0.00
  // margin. The outer round mops up the float noise in a difference of two quantised values.
  const margin = roundMoney(totalProceeds - totalCogs, decimals);

  const byCategory: SalesGroup[] = [...categoryTotals.entries()]
    .map(([id, { name, proceeds: p, cogs: c }]) => {
      const groupProceeds = roundMoney(p, decimals);
      const groupCogs = roundMoney(c, decimals);
      return {
        id,
        name,
        proceeds: groupProceeds,
        cogs: groupCogs,
        margin: roundMoney(groupProceeds - groupCogs, decimals),
        // The share stays a ratio of the raw totals — it is a fraction, not an amount, and
        // dividing rounded pennies would visibly skew a small category's percentage.
        share: share(p, proceeds),
      };
    })
    .sort((a, b) =>
      b.proceeds !== a.proceeds
        ? b.proceeds - a.proceeds
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );

  return {
    windowStart,
    windowEnd,
    proceeds: totalProceeds,
    cogs: totalCogs,
    margin,
    // Also a ratio of the raw totals, for the same reason as a group's `share`.
    marginPct: share(proceeds - cogs, proceeds),
    unitsSold,
    saleCount,
    unitsWithoutCost,
    writeOffValue: roundMoney(writeOffValue, decimals),
    writeOffUnits,
    writeOffCount,
    buckets: buckets.map((b) => {
      const bucketProceeds = roundMoney(b.proceeds, decimals);
      const bucketCogs = roundMoney(b.cogs, decimals);
      return {
        start: b.start,
        end: b.end,
        proceeds: bucketProceeds,
        cogs: bucketCogs,
        // Derived from the published pair, exactly like the headline margin.
        margin: roundMoney(bucketProceeds - bucketCogs, decimals),
      };
    }),
    byCategory,
  };
}
