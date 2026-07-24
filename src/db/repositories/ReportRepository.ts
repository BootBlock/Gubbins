/**
 * ReportRepository — read-only aggregations for the §3 Reports & valuation screen
 * (inventory-depth Phase 61) and the §4 procurement automation reorder feed (Phase 65).
 *
 * No schema change: every figure is a projection over data already stored (`items`,
 * `item_stock`, `item_history`, `categories`, `locations`, `supplier_parts`).
 *
 * The repository runs the SQL and hands the minimal raw rows to the pure helpers in
 * `@/features/reports/reports`, which own all bucketing/grouping/boundary maths (and are
 * unit-tested there). Cost lookups go through a single `effectiveUnitCost` seam in that
 * module, which delegates the precedence rule (manual cost wins, else the preferred supplier
 * cost) to the Phase-60 `supplier-cost` helper; the valuation queries feed it the preferred
 * supplier cost via {@link preferredSupplierCostSql}. Reads are unpaginated *aggregates* (a
 * fixed, tiny result set), not row dumps.
 */
import { BaseRepository } from './base';
import { parsePriceBreaks } from './mappers';
import type { SqlValue } from '@/db/rpc/driver';
import {
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  MS_PER_DAY,
  UNASSIGNED_LOCATION_ID,
  type DeadStockMode,
} from './constants';
import { buildAncestorChain } from '@/features/inventory/location-inheritance';
import { effectiveUnitValue } from '@/features/inventory/valuation';
import {
  resolveDeadStockPolicy,
  type DeadStockLocationPolicy,
  type ResolvedDeadStockPolicy,
} from '@/features/reports/dead-stock';
import {
  buildHygieneReport,
  type HygieneItemFlags,
  type HygieneReport,
} from '@/features/reports/data-hygiene';
import {
  bucketMovement,
  effectiveUnitCost,
  selectDeadStock,
  sortValueGroups,
  summariseConsumption,
  type ConsumptionRateReport,
  type DeadStockCandidate,
  type DeadStockReport,
  type InventoryValueReport,
  type LocationStatsReport,
  type MovementEvent,
  type MovementReport,
  type ValueGroupTotals,
} from '@/features/reports/reports';
import { classifyAbc, type AbcInput, type AbcReport } from '@/features/reports/abc-analysis';
import { summariseTurnover, type TurnoverInput, type TurnoverReport } from '@/features/reports/turnover';
import {
  bucketStockAging,
  parseAcquiredAt,
  type AgingInput,
  type StockAgingReport,
} from '@/features/reports/stock-aging';
import {
  buildValuationTrend,
  type ValuationEvent,
  type ValuationTrendReport,
} from '@/features/reports/valuation-trend';
import { buildSpendReport, type SpendEvent, type SpendReport } from '@/features/reports/spend-analytics';
import { buildSalesReport, type SalesEvent, type SalesReport } from '@/features/reports/sales-analytics';
import {
  createScheduleTotals,
  finaliseScheduleSummary,
  toScheduleLine,
  type InsuranceScheduleSummary,
  type ScheduleItemInput,
  type ScheduleLine,
  type ScheduleLocationInput,
} from '@/features/reports/insurance-schedule';
import {
  buildPartsCatalogue,
  type CatalogueItemInput,
  type CatalogueLocationInput,
  type CataloguePartsOptions,
  type CatalogueScope,
  type PartsCatalogue,
} from '@/features/reports/parts-catalogue';
import { THUMBNAIL_SUBQUERY } from './item/sql';
import { notAVariantParentSql } from './item/attention-sql';
import { roundMoney } from '@/lib/money';
import {
  buildReorderPlan,
  type ReorderPlanGroup,
  type ReorderShortfallRow,
} from '@/features/purchasing/reorder-plan';
import { onOrderQtyForItemSql } from './PurchaseOrderRepository';
import type { LowStockThresholds, Page, PageParams } from './types';
import { nowMs } from '@/lib/clock';

/** Default number of time buckets for the movement report (a fortnight of days fits well). */
const DEFAULT_MOVEMENT_BUCKETS = 14;

/**
 * Default trailing window (days) for ABC analysis — a calendar year, since ABC ranks items by
 * **annual** consumption value (the standard definition). The Reports screen pins this; callers
 * may still override it (e.g. tests).
 */
const DEFAULT_ABC_WINDOW_DAYS = 365;

/**
 * SQL fragment excluding abstract variant **parents** (an item that has children holds no
 * stock of its own — its variants do), mirroring `listLowStock`. Keeps the headline/category
 * valuation, the low-stock count and the dead-stock query in agreement.
 *
 * Aliases the shared {@link notAVariantParentSql} rather than restating the SQL, so the
 * reports and the attention feeds can never drift on what "abstract parent" means — see that
 * function for why it is a correlated `NOT EXISTS` and not a `NOT IN` subquery.
 */
const notAVariantParent = notAVariantParentSql;

/**
 * SQL fragment excluding unlimited-supply items (Phase 82) from valuation and dead-stock:
 * `qty × cost` is undefined for an infinite source, and an infinite source is never "dead".
 * `col` is the qualified `is_unlimited` column to test (e.g. `i.is_unlimited`).
 */
function notUnlimited(col: string): string {
  return `${col} = 0`;
}

/**
 * The shared WHERE for every insurance-schedule read: one row per active, non-parent,
 * non-unlimited item. Kept in one place so the summary's totals and a page's lines can never
 * disagree about which assets the schedule covers (issue #163) — a page listing an asset the
 * grand total omits, or vice versa, is a document that does not add up.
 */
const SCHEDULE_ITEM_FILTER = `items.is_active = 1 AND ${notAVariantParent('items.id')} AND ${notUnlimited('items.is_unlimited')}`;

/**
 * SQL predicate matching a currency column denominated in the user's base currency, and therefore
 * summable into a total (issue #284; extended to purchase orders by issue #285).
 *
 * A `currency` — on a supplier part or on a purchase order — is free ISO-4217 text the user sets,
 * and it is stored and shown **verbatim — never converted**, because Gubbins holds no exchange
 * rates (no rate column, no rate-capture timestamp, nothing). Adding a ¥9,800 part to a £ total as
 * "9800" is not an approximation, it is a wrong number — and on the insurance schedule it is a
 * wrong number in a document a user may hand to an insurer. So a foreign-currency price is
 * excluded from valuation rather than silently mis-summed, mirroring the same refusal
 * `price-refresh` already makes when asked for the cheapest of mixed-currency quotes.
 *
 * `NULL`/blank means "base currency" (the columns' documented convention), so those always
 * match — blank is tested after `TRIM`, since a whitespace-only code names no currency and can
 * reach the column through a sync merge or an import, neither of which trims the way the entry
 * dialogs do. `baseCurrency` is null when unknown, which disables the filter entirely — an
 * unknown base cannot tell foreign from domestic, and failing open preserves the previous
 * behaviour rather than blanking every total.
 *
 * `col` is the qualified currency column to test (`sp.currency`, `po.currency`); passing one the
 * enclosing query does not expose fails loudly as an unknown-column error rather than quietly
 * matching nothing.
 */
function inBaseCurrencySql(col: string, baseCurrency: string): string {
  // `baseCurrency` is normalised to three ASCII letters by `BaseRepository.baseCurrency()`,
  // so this interpolation carries no quoting or injection surface.
  return `(${col} IS NULL OR TRIM(${col}) = '' OR UPPER(TRIM(${col})) = '${baseCurrency}')`;
}

/**
 * Correlated subquery yielding the **preferred** supplier part's `unit_cost` for an item
 * (NULL when none is marked, the preferred row is unpriced, or its price is in a currency
 * other than the base — see {@link inBaseCurrencySql}). Feeds the `preferredSupplierCost`
 * fallback so valuation honours the Phase-60 cost precedence — a manual `items.unit_cost` wins,
 * else the preferred supplier cost — resolved in one place by `effectiveUnitCost`
 * (`@/features/reports/reports`). `col` is the qualified item-id column to correlate on. At most
 * one preferred row exists per item (repository invariant); the `ORDER BY` is a defensive
 * tiebreak for a malformed multi-preferred state.
 */
function preferredSupplierCostSql(col: string, baseCurrency: string | null): string {
  return `(SELECT sp.unit_cost FROM supplier_parts sp
             WHERE sp.item_id = ${col} AND sp.is_preferred = 1${
               baseCurrency === null ? '' : ` AND ${inBaseCurrencySql('sp.currency', baseCurrency)}`
             }
             ORDER BY sp.updated_at DESC LIMIT 1)`;
}

/**
 * SQL expression for an item's **effective per-unit value** — the exact rule the pure
 * `effectiveUnitValue(currentValue, effectiveUnitCost(item))` seam applies in JavaScript, in the
 * order it applies it: a manual `current_value` wins (a 0 is a deliberate "worth nothing" mark),
 * else a manual `unit_cost`, else the preferred supplier cost, else 0 (genuinely unpriced). A
 * negative figure is not a usable price, matching `usablePrice`, so it falls through.
 *
 * The one thing it does not restate is that helper's finiteness test: `normaliseUnitCost`,
 * `normaliseCurrentValue` and the supplier-part writer's `cleanCost` all reject a non-finite price
 * outright, so no infinity can be stored to be read back here, and testing for one in SQL would
 * cost a second evaluation of the correlated cost lookup for no reachable case.
 *
 * It exists so the valuation aggregates can be summed **by the database** (issue #170) instead of
 * shipping one row per item to the worker and folding them in JS: a `GROUP BY` over a 100k-item
 * inventory returns the ~50 rows the screen actually shows. The rule is stated twice as a result —
 * here and in the pure seam other reports still use — so `ReportRepository.test.ts` pins the
 * precedence cases (manual value, manual cost, supplier fallback, unpriced, zero) against real
 * SQLite to keep the two from drifting.
 *
 * `alias` is the qualified `items` alias to read; {@link preferredSupplierCostSql} is inlined once
 * (never twice) so the correlated lookup is evaluated at most once per row.
 */
function effectiveUnitValueSql(alias: string, baseCurrency: string | null): string {
  return `CASE
            WHEN ${alias}.current_value IS NOT NULL AND ${alias}.current_value >= 0 THEN ${alias}.current_value
            WHEN ${alias}.unit_cost IS NOT NULL AND ${alias}.unit_cost >= 0 THEN ${alias}.unit_cost
            ELSE MAX(COALESCE(${preferredSupplierCostSql(`${alias}.id`, baseCurrency)}, 0), 0)
          END`;
}

/**
 * SQL expression for one schedule line's replacement value as an **integer count of minor units** —
 * `roundMoney(quantity × effectiveUnitValue, decimals)` reproduced exactly in SQL so the whole
 * schedule can be summed **by the database** (issue #411) instead of shipping one row per asset to
 * the worker to fold in JS. At 100k assets that transfer was the bulk of the read; a `SUM … GROUP
 * BY` returns one row per room.
 *
 * The rule is delicate and is now stated twice — here and in `@/lib/money`'s `roundMoney` — so
 * `ReportRepository.test.ts` pins this against the pure seam over randomised fixtures at each
 * supported minor unit (0dp, 2dp, 3dp). Two things make it match where a naive `ROUND()` does not:
 *
 *  - **`printf('%.15g', …)` is `toPrecision(15)`.** `roundMoney` re-reads the scaled value at 15
 *    significant digits to collapse binary representation error (`1.005 × 100` is stored as
 *    `100.49999999999999`) back onto the decimal the user entered, so a tie rounds the way a person
 *    expects. SQLite's own `ROUND()` rounds the raw binary double and gets those ties wrong — the
 *    reason the totals could not previously move to SQL.
 *  - **Integer minor units, half away from zero.** Emitting `round(value × 10^decimals)` as an
 *    integer makes the `SUM` exact and order-independent (integer addition is associative), which is
 *    what lets the totals agree to the penny regardless of the row order SQLite scans in. The
 *    per-unit value is always ≥ 0 (see {@link effectiveUnitValueSql}) and the quantity is floored at
 *    0, so the product is non-negative and `CAST(x + 0.5 AS INTEGER)` is exactly `Math.round` of it —
 *    no negative/away-from-zero case is reachable.
 *
 * `decimals` is the reporting currency's minor unit; `10 ** decimals` is a controlled integer with
 * no quoting or injection surface. The per-unit value is floored again by {@link effectiveUnitValueSql}
 * but the explicit `MAX(…, 0)` mirrors `scheduleLineValue`'s `Math.max(0, …)` defence exactly.
 */
function scheduleLineMinorUnitsSql(alias: string, baseCurrency: string | null, decimals: number): string {
  const factor = 10 ** decimals;
  const lineValue = `MAX(${alias}.quantity, 0) * MAX(${effectiveUnitValueSql(alias, baseCurrency)}, 0)`;
  return `CAST(CAST(printf('%.15g', (${lineValue}) * ${factor}) AS REAL) + 0.5 AS INTEGER)`;
}

/** One already-summed valuation group as the `GROUP BY` queries return it. */
interface ValuationGroupRow {
  group_id: string | null;
  group_name: string | null;
  quantity: number;
  value: number;
}

/** Adapt a raw grouped row to the pure {@link sortValueGroups} input shape. */
function toValueGroupTotals(row: ValuationGroupRow): ValueGroupTotals {
  return { id: row.group_id, name: row.group_name, value: row.value, quantity: row.quantity };
}

/**
 * Correlated subquery yielding the **preferred** supplier part's supplier name for an item
 * (NULL when none is marked), for the parts-catalogue "Supplier" column. The name lives on
 * `suppliers` — a supplier part only references it — so this joins through `supplier_id`;
 * an inner join is correct because the FK is NOT NULL. Mirrors
 * {@link preferredSupplierCostSql}'s single-preferred-row invariant and defensive tiebreak.
 */
function preferredSupplierNameSql(col: string): string {
  return `(SELECT s.name FROM supplier_parts sp
             JOIN suppliers s ON s.id = sp.supplier_id
             WHERE sp.item_id = ${col} AND sp.is_preferred = 1
             ORDER BY sp.updated_at DESC LIMIT 1)`;
}

export class ReportRepository extends BaseRepository {
  /**
   * How many active items hold a **preferred supplier price quoted in another currency** and no
   * value of their own to fall back on — so {@link preferredSupplierCostSql} declines that price
   * and the item is left unvalued (issue #284).
   *
   * "No value of their own" means neither a manual `unit_cost` nor a manual `current_value`:
   * either one wins over the supplier price outright (`effectiveUnitValue` → `effectiveUnitCost`),
   * so an item carrying one is valued correctly no matter what currency its supplier quotes in.
   * Counting those would raise a false alarm about a total that is in fact complete — the exact
   * failure this notice exists to prevent, pointed the other way.
   *
   * This is the number the screens surface. Excluding a foreign price is the only correct thing
   * to do without exchange rates, but doing it silently would swap a visible overstatement for
   * an invisible understatement — worst of all on the insurance schedule. Reporting the count
   * lets the user fix it (set a manual cost, or re-quote the part in the base currency) instead
   * of trusting a total that quietly omits stock.
   *
   * Returns 0 when the base currency is unknown, since nothing is excluded in that case.
   */
  async foreignCurrencyCostCount(): Promise<number> {
    const base = this.baseCurrency();
    if (base === null) return 0;
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM items i
        WHERE i.is_active = 1 AND i.unit_cost IS NULL AND i.current_value IS NULL
          AND ${notAVariantParent('i.id')} AND ${notUnlimited('i.is_unlimited')}
          AND EXISTS (SELECT 1 FROM supplier_parts sp
                       WHERE sp.item_id = i.id AND sp.is_preferred = 1 AND sp.unit_cost IS NOT NULL
                         AND NOT ${inBaseCurrencySql('sp.currency', base)});`,
    );
    return row?.n ?? 0;
  }

  /**
   * Inventory valuation (§3): the overall `SUM(quantity × effectiveUnitCost)`, the count of
   * unpriced active items, and the value broken down **by category** and **by location**.
   * The headline + category breakdown read `items.quantity` (the item's whole on-hand
   * count); the location breakdown reads the per-location `item_stock` ledger so stock split
   * across drawers is valued where it physically sits. Active, non-parent items only.
   *
   * Both breakdowns are summed **in SQL** (issue #170): the queries return one row per category
   * and per location — a few dozen — rather than one per item, so the report costs the same to
   * fetch at 100k items as at 100. The headline is the category rollup re-summed, which is why
   * it can never disagree with the breakdown beside it.
   */
  async inventoryValue(): Promise<InventoryValueReport> {
    // The base currency valuation totals are expressed in, resolved once per report so a
    // change mid-report can never split one total across two currencies (#284).
    const base = this.baseCurrency();
    const unitValue = effectiveUnitValueSql('i', base);

    // Headline + per-category: `items.quantity` (the whole on-hand count) grouped by category.
    // The unpriced count is per *item*, so it belongs to this query and not the location one —
    // an item split across three drawers is one unpriced item, not three.
    const categoryRows = await this.driver.query<ValuationGroupRow & { unpriced: number }>(
      `SELECT group_id, group_name,
              SUM(qty) AS quantity, SUM(qty * unit_value) AS value,
              SUM(CASE WHEN unit_value > 0 THEN 0 ELSE 1 END) AS unpriced
         FROM (SELECT i.category_id AS group_id, c.name AS group_name,
                      MAX(i.quantity, 0) AS qty, ${unitValue} AS unit_value
                 FROM items i
                 LEFT JOIN categories c ON c.id = i.category_id
                WHERE i.is_active = 1 AND ${notAVariantParent('i.id')} AND ${notUnlimited('i.is_unlimited')})
        GROUP BY group_id, group_name;`,
    );

    // Per-location: the `item_stock` ledger (where stock actually sits), valued by the item.
    const locationRows = await this.driver.query<ValuationGroupRow>(
      `SELECT group_id, group_name, SUM(qty) AS quantity, SUM(qty * unit_value) AS value
         FROM (SELECT s.location_id AS group_id, l.name AS group_name,
                      MAX(s.quantity, 0) AS qty, ${unitValue} AS unit_value
                 FROM item_stock s
                 JOIN items i ON i.id = s.item_id
                 LEFT JOIN locations l ON l.id = s.location_id
                WHERE i.is_active = 1 AND s.quantity > 0 AND ${notUnlimited('i.is_unlimited')})
        GROUP BY group_id, group_name;`,
    );

    return {
      totalValue: categoryRows.reduce((sum, r) => sum + r.value, 0),
      totalQuantity: categoryRows.reduce((sum, r) => sum + r.quantity, 0),
      unpricedItemCount: categoryRows.reduce((sum, r) => sum + r.unpriced, 0),
      byCategory: sortValueGroups(categoryRows.map(toValueGroupTotals)),
      byLocation: sortValueGroups(locationRows.map(toValueGroupTotals)),
    };
  }

  /**
   * Aggregate statistics for a single location's contents (issue #458): the combined value, the
   * units and distinct active items physically held there, how many of those are unpriced, and the
   * value broken down by category. It reads the per-location `item_stock` ledger valued by the same
   * {@link effectiveUnitValueSql} seam as {@link inventoryValue}'s location breakdown, so a
   * location's total here equals its row on the Reports "value by location" list — one valuation
   * rule, never two figures for the same stock.
   *
   * With `includeSubtree` the scope is the location **plus every descendant**, resolved up-front by
   * a recursive CTE (mirroring {@link catalogueScopeFilter}), so "the Garage" rolls up every shelf
   * beneath it. Active, on-hand, non-unlimited stock only — the same filter the location breakdown
   * applies — and the base currency is resolved once so a mid-read change can never split a total.
   *
   * Both figures are summed **in SQL**: the headline folds one row per distinct item (so an item
   * split across several shelves counts once and is valued once), and the category breakdown
   * returns one row per category rather than one per placement, so the cost is the same at 100k
   * items as at 100.
   */
  async locationStats(
    locationId: string,
    options: { includeSubtree?: boolean } = {},
  ): Promise<LocationStatsReport> {
    const includesSubtree = options.includeSubtree ?? false;
    const base = this.baseCurrency();
    const unitValue = effectiveUnitValueSql('i', base);

    // The scope is the location alone, or (with the subtree) it and every descendant — resolved
    // here so the filter is a bound `IN (…)` of ids, never string-built location names.
    const scopeIds = includesSubtree
      ? (
          await this.driver.query<{ id: string }>(
            `WITH RECURSIVE subtree(id) AS (
               SELECT ?
               UNION
               SELECT l.id FROM locations l JOIN subtree s ON l.parent_id = s.id
             )
             SELECT id FROM subtree;`,
            [locationId],
          )
        ).map((r) => r.id)
      : [locationId];
    const scopeClause = `s.location_id IN (${scopeIds.map(() => '?').join(', ')})`;

    // Headline: fold to one row per distinct item first (SUM its stock across the scoped
    // locations, valued once), then the outer aggregate counts and totals those items — so an
    // item spread over three drawers is one distinct item, valued once, not three.
    const headline = await this.driver.queryOne<{
      quantity: number;
      value: number;
      distinct_items: number;
      priced_items: number;
      used_volume: number;
      measured_items: number;
    }>(
      // `unit_volume` is the item's bounding-box volume (mm³), NULL when any dimension is unset —
      // so an unmeasured item adds nothing to `used_volume` and isn't counted as measured, exactly
      // the convention the location tree's volume bar uses (issue #457).
      `SELECT COALESCE(SUM(qty), 0) AS quantity,
              COALESCE(SUM(qty * unit_value), 0) AS value,
              COUNT(*) AS distinct_items,
              COUNT(CASE WHEN unit_value > 0 THEN 1 END) AS priced_items,
              COALESCE(SUM(CASE WHEN unit_volume IS NOT NULL THEN qty * unit_volume ELSE 0 END), 0) AS used_volume,
              COUNT(CASE WHEN unit_volume IS NOT NULL THEN 1 END) AS measured_items
         FROM (SELECT MAX(SUM(s.quantity), 0) AS qty, ${unitValue} AS unit_value,
                      (i.width * i.height * i.depth) AS unit_volume
                 FROM item_stock s
                 JOIN items i ON i.id = s.item_id
                WHERE i.is_active = 1 AND s.quantity > 0 AND ${notUnlimited('i.is_unlimited')}
                  AND ${scopeClause}
                GROUP BY s.item_id);`,
      scopeIds,
    );

    // Value by category over the same scope — one row per category, ungrouped last.
    const categoryRows = await this.driver.query<ValuationGroupRow>(
      `SELECT group_id, group_name, SUM(qty) AS quantity, SUM(qty * unit_value) AS value
         FROM (SELECT i.category_id AS group_id, c.name AS group_name,
                      MAX(s.quantity, 0) AS qty, ${unitValue} AS unit_value
                 FROM item_stock s
                 JOIN items i ON i.id = s.item_id
                 LEFT JOIN categories c ON c.id = i.category_id
                WHERE i.is_active = 1 AND s.quantity > 0 AND ${notUnlimited('i.is_unlimited')}
                  AND ${scopeClause})
        GROUP BY group_id, group_name;`,
      scopeIds,
    );

    const distinctItemCount = headline?.distinct_items ?? 0;
    return {
      includesSubtree,
      locationCount: scopeIds.length,
      totalValue: headline?.value ?? 0,
      totalQuantity: headline?.quantity ?? 0,
      distinctItemCount,
      unpricedItemCount: distinctItemCount - (headline?.priced_items ?? 0),
      usedVolume: headline?.used_volume ?? 0,
      measuredItemCount: headline?.measured_items ?? 0,
      byCategory: sortValueGroups(categoryRows.map(toValueGroupTotals)),
    };
  }

  /**
   * Insurance / estate schedule (feature-gap G1) — the document's **totals and shape**, with no
   * lines: ordered room groups, each with its asset count and subtotal, plus the grand total.
   *
   * Summed **in the database** (issue #411): one grouped row per room rather than one transferred
   * row per asset. A prior read streamed every matching asset to the worker to fold in JS, which at
   * 100k assets spent the bulk of its time simply moving 100k row objects across the worker boundary
   * to produce a few dozen numbers. Each line is quantised to integer minor units by
   * {@link scheduleLineMinorUnitsSql} — reproducing `roundMoney` exactly — so the `SUM` is exact and
   * order-independent, and the result feeds the *same* {@link finaliseScheduleSummary} seam
   * (ordering, subtotals, grand total, "Unassigned" bucket) the paged and in-memory reads use.
   * Nothing here selects a thumbnail: totalling a schedule never needs the photos, and at 100k
   * assets those BLOBs are hundreds of megabytes.
   *
   * The group key is normalised through a `LEFT JOIN` to `locations`, so an asset whose location is
   * unset **or** points at a deleted location folds into the null ("Unassigned") group exactly as
   * {@link resolveScheduleGroupKey} did — narrowing that to `location_id IS NULL` would silently drop
   * assets pointing at a deleted room from a document someone claims against.
   *
   * Cost flows through the same `effectiveUnitCost` seam as the valuation report (manual cost wins,
   * else the preferred supplier cost, via {@link preferredSupplierCostSql}), so the figures a page
   * shows and the totals above them come from one rule.
   */
  async insuranceScheduleSummary(now: number = nowMs()): Promise<InsuranceScheduleSummary> {
    const base = this.baseCurrency();
    const decimals = this.moneyDecimals();
    const factor = 10 ** decimals;
    const locations = await this.scheduleLocations();

    const rows = await this.driver.query<{ group_id: string | null; n: number; minor: number | null }>(
      `SELECT loc.id AS group_id, COUNT(*) AS n,
              SUM(${scheduleLineMinorUnitsSql('items', base, decimals)}) AS minor
         FROM items
         LEFT JOIN locations loc ON loc.id = items.location_id
        WHERE ${SCHEDULE_ITEM_FILTER}
        GROUP BY loc.id;`,
    );

    // Rebuild the pure accumulator's state from the grouped rows so the finalisation is byte-for-byte
    // the streamed read's: integer minor units are exact, and the float sum is only the fallback
    // `finaliseScheduleSummary` reaches past ~90 trillion at 2dp (no real inventory does).
    const totals = createScheduleTotals();
    for (const row of rows) {
      const minorUnits = row.minor ?? 0;
      totals.byLocation.set(row.group_id, { count: row.n, minorUnits, floatSum: minorUnits / factor });
      if (!Number.isSafeInteger(minorUnits)) totals.exact = false;
    }

    return finaliseScheduleSummary(totals, locations, now, decimals);
  }

  /**
   * One bounded page of a single room's schedule lines, ordered as the document orders them.
   *
   * A page is addressed per-group rather than document-wide because the schedule's group order
   * is the location *hierarchy*, which is resolved in TypeScript over a bounded set of locations
   * (`flattenLocationHierarchy`). The caller maps a document offset onto group slices with
   * `scheduleSlices`; this only has to serve one room's contiguous run.
   *
   * `locationId` is `null` for the trailing "Unassigned" bucket, which must also pick up assets
   * pointing at a **deleted** location — mirroring {@link resolveScheduleGroupKey}. Narrowing
   * that to `IS NULL` would silently drop those assets from a document someone claims against.
   *
   * The thumbnail BLOB is fetched only when the Photo column is on, exactly as
   * {@link partsCatalogue} does — an unneeded per-row BLOB is the bulk of a large schedule's
   * payload (issue #163).
   */
  async insuranceScheduleGroupPage(
    locationId: string | null,
    params: PageParams = {},
    options: { readonly includePhotos?: boolean } = {},
    now: number = nowMs(),
  ): Promise<Page<ScheduleLine>> {
    const base = this.baseCurrency();
    const { limit, offset } = this.resolvePage(params);
    const thumbnailSelect = options.includePhotos ? THUMBNAIL_SUBQUERY : 'NULL AS thumbnail_blob';
    const locationFilter =
      locationId === null
        ? '(items.location_id IS NULL OR items.location_id NOT IN (SELECT id FROM locations))'
        : 'items.location_id = ?';
    const queryParams: (string | number)[] =
      locationId === null ? [limit, offset] : [locationId, limit, offset];

    const rows = await this.driver.query<{
      id: string;
      name: string;
      serial_no: number | null;
      condition: string | null;
      quantity: number;
      unit_cost: number | null;
      current_value: number | null;
      purchase_price: number | null;
      acquired_at: string | null;
      warranty_expires_at: string | null;
      location_id: string | null;
      preferred_supplier_cost: number | null;
      thumbnail_blob: Uint8Array | null;
    }>(
      `SELECT items.id AS id, items.name AS name, items.serial_no AS serial_no, items.condition AS condition,
              items.quantity AS quantity, items.unit_cost AS unit_cost, items.current_value AS current_value,
              items.purchase_price AS purchase_price,
              items.acquired_at AS acquired_at, items.warranty_expires_at AS warranty_expires_at,
              items.location_id AS location_id,
              ${preferredSupplierCostSql('items.id', base)} AS preferred_supplier_cost,
              ${thumbnailSelect}
         FROM items
        WHERE ${SCHEDULE_ITEM_FILTER} AND ${locationFilter}
        ORDER BY items.name COLLATE NOCASE, items.id
        LIMIT ? OFFSET ?;`,
      queryParams,
    );

    const decimals = this.moneyDecimals();
    const lines = rows.map((r) =>
      toScheduleLine(
        {
          id: r.id,
          name: r.name,
          serialNo: r.serial_no,
          condition: (r.condition as ScheduleItemInput['condition']) ?? null,
          quantity: r.quantity,
          acquiredAt: r.acquired_at,
          warrantyExpiresAt: r.warranty_expires_at,
          purchasePrice: r.purchase_price,
          unitCost: r.unit_cost,
          // Feature-gap G9: the manual current value wins over the replacement cost.
          currentValuePerUnit: r.current_value,
          preferredSupplierCost: r.preferred_supplier_cost,
          locationId: r.location_id,
          thumbnail: r.thumbnail_blob ?? null,
        },
        now,
        decimals,
      ),
    );
    return this.toPage(lines, limit, offset);
  }

  /** The location rows the schedule groups and orders by. Bounded by the location count. */
  private async scheduleLocations(): Promise<ScheduleLocationInput[]> {
    const rows = await this.driver.query<{ id: string; name: string; parent_id: string | null }>(
      `SELECT id, name, parent_id FROM locations;`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
  }

  /**
   * Parts catalogue (issue #22): a printable list of items scoped by `all`, by a location and
   * its whole subtree, by a project's bill of materials, or by an explicit ad-hoc selection.
   * One row per active, non-parent item (a variant parent holds no stock of its own); the
   * pure {@link buildPartsCatalogue} groups them by location and rolls up value subtotals.
   * Cost flows through the same {@link preferredSupplierCostSql} → `effectiveUnitCost` seam as
   * every valuation. The columns the reader ultimately prints are a UI concern — every field
   * is resolved here.
   */
  async partsCatalogue(
    scope: CatalogueScope,
    options: CataloguePartsOptions = {},
    now: number = nowMs(),
  ): Promise<PartsCatalogue> {
    const base = this.baseCurrency();
    const filter = await this.catalogueScopeFilter(scope);
    // An empty ad-hoc selection resolves to nothing — short-circuit rather than emit an
    // `IN ()` (a syntax error) or fetch the whole catalogue.
    if (filter === null) {
      return { groups: [], grandTotal: 0, totalQuantity: 0, itemCount: 0, hasValue: false, generatedAt: now };
    }

    // The thumbnail BLOB is only fetched when the Photo column is on — an unneeded per-item
    // BLOB would bloat the payload of a large, text-only catalogue.
    const thumbnailSelect = options.includePhotos ? `${THUMBNAIL_SUBQUERY}` : `NULL AS thumbnail_blob`;

    const itemRows = await this.driver.query<{
      id: string;
      name: string;
      location_id: string;
      category_name: string | null;
      description: string | null;
      quantity: number;
      unit_of_measure: string | null;
      condition: string | null;
      serial_no: number | null;
      mpn: string | null;
      manufacturer: string | null;
      supplier_name: string | null;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      purchase_price: number | null;
      acquired_at: string | null;
      warranty_expires_at: string | null;
      notes: string | null;
      thumbnail_blob: Uint8Array | null;
    }>(
      `SELECT items.id AS id, items.name AS name, items.location_id AS location_id,
              categories.name AS category_name,
              items.description AS description,
              items.quantity AS quantity, items.unit_of_measure AS unit_of_measure,
              items.condition AS condition, items.serial_no AS serial_no,
              items.mpn AS mpn, items.manufacturer AS manufacturer,
              ${preferredSupplierNameSql('items.id')} AS supplier_name,
              items.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('items.id', base)} AS preferred_supplier_cost,
              items.purchase_price AS purchase_price,
              items.acquired_at AS acquired_at, items.warranty_expires_at AS warranty_expires_at,
              items.notes AS notes,
              ${thumbnailSelect}
         FROM items
         LEFT JOIN categories ON categories.id = items.category_id
        WHERE items.is_active = 1 AND ${notAVariantParent('items.id')}${filter.clause};`,
      filter.params,
    );

    const locationRows = await this.driver.query<{
      id: string;
      name: string;
      parent_id: string | null;
    }>(`SELECT id, name, parent_id FROM locations;`);

    const items: CatalogueItemInput[] = itemRows.map((r) => ({
      id: r.id,
      name: r.name,
      locationId: r.location_id,
      category: r.category_name,
      description: r.description,
      thumbnail: r.thumbnail_blob ?? null,
      quantity: r.quantity,
      unitOfMeasure: r.unit_of_measure,
      condition: (r.condition as CatalogueItemInput['condition']) ?? null,
      serialNo: r.serial_no,
      mpn: r.mpn,
      manufacturer: r.manufacturer,
      supplier: r.supplier_name,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
      purchasePrice: r.purchase_price,
      acquiredAt: r.acquired_at,
      warrantyExpiresAt: r.warranty_expires_at,
      notes: r.notes,
    }));
    const locations: CatalogueLocationInput[] = locationRows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
    }));

    return buildPartsCatalogue(items, locations, now, {
      groupBy: options.groupBy,
      sortBy: options.sortBy,
    });
  }

  /**
   * Resolve a {@link CatalogueScope} to the extra `WHERE` clause (appended to the base active +
   * non-variant-parent predicate) and its bind params. Returns `null` for an empty selection —
   * the one case that must yield no rows rather than an `IN ()`. The location scope resolves
   * the target's whole subtree up-front via a recursive CTE (mirrors the kit-descendant query),
   * so a catalogue "for the Garage" includes every shelf beneath it.
   */
  private async catalogueScopeFilter(
    scope: CatalogueScope,
  ): Promise<{ clause: string; params: SqlValue[] } | null> {
    switch (scope.kind) {
      case 'all':
        return { clause: '', params: [] };
      case 'location': {
        const rows = await this.driver.query<{ id: string }>(
          `WITH RECURSIVE subtree(id) AS (
             SELECT ?
             UNION
             SELECT l.id FROM locations l JOIN subtree s ON l.parent_id = s.id
           )
           SELECT id FROM subtree;`,
          [scope.locationId],
        );
        const ids = rows.map((r) => r.id);
        if (ids.length === 0) return null;
        return {
          clause: ` AND items.location_id IN (${ids.map(() => '?').join(', ')})`,
          params: ids,
        };
      }
      case 'project':
        return {
          clause: ` AND items.id IN (SELECT DISTINCT item_id FROM project_bom_lines
                                      WHERE project_id = ? AND item_id IS NOT NULL)`,
          params: [scope.projectId],
        };
      case 'items': {
        if (scope.itemIds.length === 0) return null;
        return {
          clause: ` AND items.id IN (${scope.itemIds.map(() => '?').join(', ')})`,
          params: [...scope.itemIds],
        };
      }
    }
  }

  /**
   * Consumption rate (§3) over the trailing `windowDays`: the total units consumed and the
   * mean per-day, drawn from `item_history` **negative** quantity deltas (a stock-out) and
   * gauge net-value reductions. `windowEnd` defaults to `now`.
   */
  async consumptionRate(windowDays: number, now: number = nowMs()): Promise<ConsumptionRateReport> {
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;
    const rows = await this.driver.query<{ created_at: number; consumed: number }>(
      `SELECT created_at,
              ( COALESCE(-MIN(quantity_delta, 0), 0)
              + COALESCE(-MIN(net_value_delta, 0), 0) ) AS consumed
         FROM item_history
        WHERE created_at >= ? AND created_at < ?
          AND (quantity_delta < 0 OR net_value_delta < 0);`,
      [windowStart, now],
    );
    return summariseConsumption(
      rows.map((r) => ({ createdAt: r.created_at, consumed: r.consumed })),
      windowStart,
      now,
    );
  }

  /**
   * Stock movement (§3): signed `item_history` quantity deltas bucketed into `buckets`
   * equal time spans across the trailing `windowDays`, as ins (positive) and outs
   * (negative magnitude). `windowEnd` defaults to `now`.
   */
  async movement(
    windowDays: number,
    buckets: number = DEFAULT_MOVEMENT_BUCKETS,
    now: number = nowMs(),
  ): Promise<MovementReport> {
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;
    const rows = await this.driver.query<{ created_at: number; quantity_delta: number | null }>(
      `SELECT created_at, quantity_delta
         FROM item_history
        WHERE created_at >= ? AND created_at < ? AND quantity_delta IS NOT NULL AND quantity_delta <> 0;`,
      [windowStart, now],
    );
    const events: MovementEvent[] = rows.map((r) => ({
      createdAt: r.created_at,
      delta: r.quantity_delta ?? 0,
    }));
    return bucketMovement(events, windowStart, now, buckets);
  }

  /**
   * The number of active items running low (§3) — the same predicate as
   * `ItemRepository.listLowStock`, surfaced as a headline count. Each row is judged against
   * its own `reorder_point` / `reorder_gauge_percent` when set, else the global threshold,
   * and only when that effective floor is *strictly positive* (low-stock is opt-in — an
   * effective floor of 0 is "off"). DISCRETE items at/below the effective quantity floor and
   * CONSUMABLE_GAUGE items at/below the effective percentage floor; SERIALISED singles and
   * abstract variant parents are excluded.
   */
  async lowStockCount(thresholds: LowStockThresholds = {}): Promise<number> {
    const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
    const pct = thresholds.gaugePercent ?? LOW_STOCK_GAUGE_PERCENT;
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items
        WHERE is_active = 1
          AND is_unlimited = 0
          AND ${notAVariantParent('items.id')}
          AND (
            (tracking_mode = 'DISCRETE'
               AND COALESCE(reorder_point, ?) > 0
               AND quantity <= COALESCE(reorder_point, ?))
            OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0
                AND COALESCE(reorder_gauge_percent, ?) > 0
                AND current_net_value <= gross_capacity * COALESCE(reorder_gauge_percent, ?) / 100.0)
          );`,
      [qty, qty, pct, pct],
    );
    return row?.n ?? 0;
  }

  /**
   * The number of active items **out of stock** — a headline count for the Dashboard nav tile
   * (backlog A2). Unlike {@link lowStockCount} (a reorder-point *threshold*), this is the hard
   * floor: a DISCRETE item at zero on-hand, or a CONSUMABLE_GAUGE with a real capacity now down
   * to empty. It shares the same guards as low-stock — active only, unlimited-supply items are
   * never "out" (an infinite source can't run dry), and abstract variant parents (which hold no
   * stock of their own) are excluded. SERIALISED and UNTRACKED items are excluded deliberately:
   * a serialised unit is present-or-removed rather than "out of stock", and an UNTRACKED item
   * sits at quantity 0 *by design* (it opts out of stock counting), so counting either as
   * out-of-stock would be misleading.
   */
  async outOfStockCount(): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items
        WHERE is_active = 1
          AND is_unlimited = 0
          AND ${notAVariantParent('items.id')}
          AND (
            (tracking_mode = 'DISCRETE' AND quantity <= 0)
            OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0 AND current_net_value <= 0)
          );`,
    );
    return row?.n ?? 0;
  }

  /**
   * Read the location tree once and return a memoised nearest-first ancestry lookup carrying
   * each location's dead-stock policy (issue #92), ready for `resolveDeadStockPolicy`.
   *
   * The tree is bounded by the number of *locations*, not items, so reading it whole is far
   * cheaper than a per-item recursive CTE. Chains are memoised per **location**, not per
   * item: items sharing a location — the common case — resolve the same walk once.
   */
  private async deadStockChainResolver(): Promise<(locationId: string) => DeadStockLocationPolicy[]> {
    const locations = await this.driver.query<{
      id: string;
      name: string;
      parent_id: string | null;
      dead_stock_mode: DeadStockMode;
      dead_stock_days: number | null;
    }>(`SELECT id, name, parent_id, dead_stock_mode, dead_stock_days FROM locations;`);

    const byId = new Map(locations.map((l) => [l.id, l]));
    const parents = new Map(locations.map((l) => [l.id, { name: l.name, parentId: l.parent_id }] as const));
    const cache = new Map<string, DeadStockLocationPolicy[]>();

    return (locationId: string): DeadStockLocationPolicy[] => {
      let chain = cache.get(locationId);
      if (chain === undefined) {
        chain = buildAncestorChain(locationId, parents).map((link) => {
          const row = byId.get(link.id);
          return {
            id: link.id,
            name: link.name,
            mode: row?.dead_stock_mode ?? 'inherit',
            thresholdDays: row?.dead_stock_days ?? null,
          };
        });
        cache.set(locationId, chain);
      }
      return chain;
    };
  }

  /**
   * The **resolved** dead-stock policy for a single item (issue #92) — whether it is
   * reported, the idle threshold that applies, and which location decided each. Powers the
   * explanatory note in the item editor, where "Inherit" alone tells the user nothing about
   * whether the item is actually being watched.
   *
   * Returns null when the item doesn't exist.
   */
  async deadStockPolicy(
    itemId: string,
    defaultThresholdDays: number,
  ): Promise<ResolvedDeadStockPolicy | null> {
    const row = await this.driver.queryOne<{
      location_id: string;
      dead_stock_mode: DeadStockMode;
    }>(`SELECT location_id, dead_stock_mode FROM items WHERE id = ?;`, [itemId]);
    if (!row) return null;

    const chainFor = await this.deadStockChainResolver();
    return resolveDeadStockPolicy(row.dead_stock_mode, chainFor(row.location_id), defaultThresholdDays);
  }

  /**
   * Dead stock (§3): items **opted in** to dead-stock reporting that have not moved within
   * their idle threshold, with the capital tied up. "Last moved" is the most recent
   * `item_history` entry that changed quantity or gauge value; an item that has never moved
   * falls back to its `created_at`. The boundary is inclusive (idle for exactly the
   * threshold qualifies); see `selectDeadStock`.
   *
   * Reporting is opt-in (issue #92): an item is included only when its own `dead_stock_mode`
   * says `always`, or it defers (`inherit`) to a location in its ancestry that says so. Both
   * the opt-in and the effective threshold — `sinceDays` unless a location overrides it —
   * are resolved by the pure `resolveDeadStockPolicy` seam, which this feeds with the
   * ancestry the SQL below walks. An untouched database opts nothing in, so the common case
   * short-circuits before the location tree is ever read.
   */
  async deadStock(sinceDays: number, now: number = nowMs()): Promise<DeadStockReport> {
    const base = this.baseCurrency();
    const rows = await this.driver.query<{
      id: string;
      name: string;
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      created_at: number;
      last_moved_at: number | null;
      location_id: string;
      dead_stock_mode: DeadStockMode;
    }>(
      `SELECT i.id AS id, i.name AS name, i.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id', base)} AS preferred_supplier_cost,
              i.created_at AS created_at,
              i.location_id AS location_id,
              i.dead_stock_mode AS dead_stock_mode,
              ( SELECT MAX(h.created_at) FROM item_history h
                 WHERE h.item_id = i.id
                   AND (h.quantity_delta IS NOT NULL OR h.net_value_delta IS NOT NULL) ) AS last_moved_at
         FROM items i
        WHERE i.is_active = 1
          AND i.quantity > 0
          AND ${notAVariantParent('i.id')}
          AND ${notUnlimited('i.is_unlimited')};`,
    );

    // The location tree decides the opt-in for every item still set to 'inherit' — which is
    // the default, so it is almost always needed; only an inventory whose every candidate
    // carries an explicit override can skip the read.
    const needsTree = rows.some((r) => r.dead_stock_mode === 'inherit');
    const chainFor = needsTree ? await this.deadStockChainResolver() : () => [];

    const candidates: DeadStockCandidate[] = [];
    for (const r of rows) {
      const policy = resolveDeadStockPolicy(r.dead_stock_mode, chainFor(r.location_id), sinceDays);
      if (!policy.reported) continue;
      candidates.push({
        id: r.id,
        name: r.name,
        quantity: r.quantity,
        unitCost: r.unit_cost,
        preferredSupplierCost: r.preferred_supplier_cost,
        lastMovedAt: r.last_moved_at,
        createdAt: r.created_at,
        thresholdDays: policy.thresholdDays,
      });
    }
    return selectDeadStock(candidates, sinceDays, now);
  }

  /**
   * Low-stock shortfall rows joined to each item's preferred supplier-part (Phase 65).
   *
   * Mirrors the `listLowStock` SQL predicate (same `COALESCE(reorder_point, ?)` floor,
   * same strictly-positive-floor opt-in guard, same DISCRETE-only restriction —
   * CONSUMABLE_GAUGE items have no countable order unit) and joins the single preferred
   * `supplier_parts` row for each item so the caller can immediately feed the result into
   * {@link buildReorderPlan} without a second round-trip.
   *
   * The base shortfall is `COALESCE(reorder_qty, COALESCE(reorder_point, ?) - quantity)` —
   * i.e. the per-item explicit top-up amount when set, else the distance from on-hand to
   * the effective floor (matching `shortfall()` in `reorder-policy.ts`). Stock already **on
   * order** (open ORDERED/PARTIAL POs — see {@link onOrderQtyForItemSql}) is then netted off so
   * the plan never re-suggests what is already arriving: the effective shortfall is
   * `max(0, base − onOrder)`, and an item whose incoming stock fully covers its top-up drops
   * out of the plan entirely (`buildReorderPlan` skips a zero shortfall). The low-stock *alert*
   * deliberately stays on-hand-based — you are low now even if more is coming — so this netting
   * lives only here, on the procurement action.
   */
  async listReorderShortfall(thresholds: LowStockThresholds = {}): Promise<ReorderShortfallRow[]> {
    const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
    const rows = await this.driver.query<{
      item_id: string;
      item_name: string;
      base_shortfall: number;
      on_order: number;
      supplier_part_id: string | null;
      supplier_id: string | null;
      supplier_name: string | null;
      unit_cost: number | null;
      pack_qty: number | null;
      min_order_qty: number | null;
      price_breaks: string | null;
    }>(
      // Only DISCRETE items with countable shortfall (CONSUMABLE_GAUGE has no countable
      // top-up unit); SERIALISED singles and abstract variant parents are excluded as in
      // listLowStock. The LEFT JOIN brings the preferred supplier-part row — NULL when
      // none is marked preferred — and a second LEFT JOIN resolves that part's supplier for
      // its name (it must stay LEFT: the part row itself may be absent, even though a part
      // always has a supplier). The id is what the plan groups on; the name is display data.
      // `on_order` is the still-incoming quantity; the effective shortfall (base − on_order,
      // floored at 0) is computed in JS below.
      `SELECT i.id AS item_id,
              i.name AS item_name,
              COALESCE(
                i.reorder_qty,
                MAX(0, COALESCE(i.reorder_point, ?) - i.quantity)
              ) AS base_shortfall,
              ${onOrderQtyForItemSql('i.id')} AS on_order,
              sp.id          AS supplier_part_id,
              sp.supplier_id AS supplier_id,
              s.name         AS supplier_name,
              sp.unit_cost,
              sp.pack_qty,
              sp.min_order_qty,
              sp.price_breaks
         FROM items i
         LEFT JOIN supplier_parts sp
                ON sp.item_id = i.id AND sp.is_preferred = 1
         LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE i.is_active = 1
          AND i.tracking_mode = 'DISCRETE'
          AND i.is_unlimited = 0
          AND COALESCE(i.reorder_point, ?) > 0
          AND i.quantity <= COALESCE(i.reorder_point, ?)
          AND ${notAVariantParent('i.id')}
        ORDER BY (CAST(i.quantity AS REAL) / MAX(COALESCE(i.reorder_point, ?), 1)) ASC,
                 i.name COLLATE NOCASE ASC;`,
      [qty, qty, qty, qty],
    );

    return rows.map((r) => {
      const onOrder = Number(r.on_order);
      return {
        itemId: r.item_id,
        itemName: r.item_name,
        // Net already-incoming stock off the base shortfall so the plan doesn't double-order.
        shortfall: Math.max(0, Number(r.base_shortfall) - onOrder),
        onOrder,
        preferredSupplier: r.supplier_part_id
          ? {
              supplierPartId: r.supplier_part_id,
              supplierId: r.supplier_id!,
              supplierName: r.supplier_name!,
              unitCost: r.unit_cost,
              packQty: r.pack_qty,
              minOrderQty: r.min_order_qty,
              // Threaded through so the plan can cost each line at its computed order quantity
              // when the preferred supplier offers a volume price-break (issue #37).
              priceBreaks: parsePriceBreaks(r.price_breaks),
            }
          : null,
      };
    });
  }

  /**
   * The full reorder plan (Phase 65): shortfall rows grouped by preferred supplier, with
   * order quantities computed (MOQ + pack rounding). Delegates to the pure
   * {@link buildReorderPlan} helper — the repository is responsible only for fetching the
   * input rows.
   */
  async reorderPlan(thresholds: LowStockThresholds = {}): Promise<readonly ReorderPlanGroup[]> {
    const rows = await this.listReorderShortfall(thresholds);
    return buildReorderPlan(rows);
  }

  // Phase 74 — advanced analytics ------------------------------------------------

  /**
   * ABC (Pareto) classification (§3 advanced analytics): each active, non-parent item's
   * **annual consumption value** = units consumed over the trailing `windowDays` (the positive
   * magnitude of `item_history` stock-out deltas) × its {@link effectiveUnitCost}. The pure
   * {@link classifyAbc} helper owns the cumulative-value split into A/B/C tiers; the repository
   * only fetches the per-item consumed-units + cost rows. `windowDays` defaults to a calendar
   * year (the annual definition); `now` defaults to the wall clock.
   */
  async abcAnalysis(windowDays: number = DEFAULT_ABC_WINDOW_DAYS, now: number = nowMs()): Promise<AbcReport> {
    const base = this.baseCurrency();
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;
    const rows = await this.driver.query<{
      id: string;
      name: string;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      consumed: number;
    }>(
      // `-SUM(quantity_delta)` over the negative (stock-out) deltas is the positive consumed
      // magnitude; COALESCE keeps an item that never moved at 0 rather than NULL.
      `SELECT i.id AS id, i.name AS name, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id', base)} AS preferred_supplier_cost,
              COALESCE((SELECT -SUM(h.quantity_delta) FROM item_history h
                         WHERE h.item_id = i.id AND h.created_at >= ? AND h.created_at < ?
                           AND h.quantity_delta < 0), 0) AS consumed
         FROM items i
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')};`,
      [windowStart, now],
    );
    const inputs: AbcInput[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
      consumedUnits: r.consumed,
    }));
    return classifyAbc(inputs);
  }

  /**
   * Inventory turnover (§3 advanced analytics) over the trailing `windowDays`: per active,
   * non-parent item the cost of goods consumed (`-SUM(MIN(quantity_delta, 0))` × cost) divided
   * by the **average** on-hand value. Because no historical value snapshots exist, the pure
   * {@link summariseTurnover} helper reconstructs the window-start quantity by reversing the net
   * ledger movement (`netQtyDelta = SUM(quantity_delta)`); the repository supplies the current
   * quantity, the consumed magnitude and that net delta. `now` defaults to the wall clock.
   */
  async turnover(windowDays: number, now: number = nowMs()): Promise<TurnoverReport> {
    const base = this.baseCurrency();
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;
    const rows = await this.driver.query<{
      id: string;
      name: string;
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      consumed: number;
      net_delta: number;
    }>(
      `SELECT i.id AS id, i.name AS name, i.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id', base)} AS preferred_supplier_cost,
              COALESCE((SELECT -SUM(h.quantity_delta) FROM item_history h
                         WHERE h.item_id = i.id AND h.created_at >= ? AND h.created_at < ?
                           AND h.quantity_delta < 0), 0) AS consumed,
              COALESCE((SELECT SUM(h.quantity_delta) FROM item_history h
                         WHERE h.item_id = i.id AND h.created_at >= ? AND h.created_at < ?
                           AND h.quantity_delta IS NOT NULL), 0) AS net_delta
         FROM items i
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')};`,
      [windowStart, now, windowStart, now],
    );
    const inputs: TurnoverInput[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      currentQty: r.quantity,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
      consumedUnits: r.consumed,
      netQtyDelta: r.net_delta,
    }));
    return summariseTurnover(inputs, windowDays);
  }

  /**
   * Stock aging (§3 advanced analytics): on-hand stock bucketed by the age of its **newest
   * inbound** — the most recent `item_history` positive-quantity movement, else the parsed
   * `items.acquired_at`, else `created_at` (resolved in the pure {@link bucketStockAging}). Only
   * active, non-parent items holding stock are aged. `now` defaults to the wall clock.
   */
  async stockAging(now: number = nowMs()): Promise<StockAgingReport> {
    const base = this.baseCurrency();
    const rows = await this.driver.query<{
      id: string;
      name: string;
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      acquired_at: string | null;
      created_at: number;
      last_inbound_at: number | null;
    }>(
      `SELECT i.id AS id, i.name AS name, i.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id', base)} AS preferred_supplier_cost,
              i.acquired_at AS acquired_at, i.created_at AS created_at,
              ( SELECT MAX(h.created_at) FROM item_history h
                 WHERE h.item_id = i.id AND h.quantity_delta > 0 ) AS last_inbound_at
         FROM items i
        WHERE i.is_active = 1 AND i.quantity > 0 AND ${notAVariantParent('i.id')};`,
    );
    const inputs: AgingInput[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      quantity: r.quantity,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
      lastInboundAt: r.last_inbound_at,
      acquiredAtMs: parseAcquiredAt(r.acquired_at),
      createdAt: r.created_at,
    }));
    return bucketStockAging(inputs, now);
  }

  /**
   * Valuation over time (§3 advanced analytics): the total inventory value reconstructed across
   * the trailing `windowDays` at `points` evenly-spaced samples, for a sparkline. The current
   * total anchors the line; the pure {@link buildValuationTrend} helper reverses the value-tagged
   * ledger from it. Each in-window `item_history` quantity delta is valued by its item here (so
   * the single cost-precedence rule stays in {@link effectiveUnitCost}).
   *
   * The anchor and every event are valued through exactly the same rules as
   * {@link inventoryValue}'s headline — a manual `current_value` wins over the replacement cost
   * (`effectiveUnitValue`), and unlimited sources are excluded because they hold no finite value.
   * Both figures sit side by side on the Reports screen and flow into the same export, so any
   * divergence between them reads as a contradiction rather than a different measure (issue #289).
   *
   * Both the anchor and the in-window events use each item's value **as it stands today** — no
   * historical value snapshots are consulted, so an item revalued (or re-costed) mid-window has
   * its earlier movements priced at the new figure. That is the deliberate trade: it is what makes
   * the right-hand endpoint land exactly on the headline, and the alternative (replaying the
   * revaluation log per event) would draw a line that no longer ends where the headline says the
   * inventory is worth. Active, non-parent items only. `now` defaults to the wall clock.
   */
  async valuationTrend(
    windowDays: number,
    points: number,
    now: number = nowMs(),
  ): Promise<ValuationTrendReport> {
    const base = this.baseCurrency();
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;

    // Current total value — the anchor the trend is reconstructed backward from. Summed by the
    // database over the same predicates and the same value rule as the {@link inventoryValue}
    // headline (issue #170), so the right-hand endpoint lands exactly on the headline figure
    // beside it rather than merely near it.
    const anchor = await this.driver.queryOne<{ total: number | null }>(
      `SELECT SUM(MAX(i.quantity, 0) * (${effectiveUnitValueSql('i', base)})) AS total
         FROM items i
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')} AND ${notUnlimited('i.is_unlimited')};`,
    );
    const currentValue = anchor?.total ?? 0;

    // Value-tagged ledger events inside the window (half-open at the start; inclusive of now).
    const eventRows = await this.driver.query<{
      created_at: number;
      quantity_delta: number;
      unit_cost: number | null;
      current_value: number | null;
      preferred_supplier_cost: number | null;
    }>(
      `SELECT h.created_at AS created_at, h.quantity_delta AS quantity_delta,
              i.unit_cost AS unit_cost, i.current_value AS current_value,
              ${preferredSupplierCostSql('i.id', base)} AS preferred_supplier_cost
         FROM item_history h
         JOIN items i ON i.id = h.item_id
        WHERE h.created_at > ? AND h.created_at <= ?
          AND h.quantity_delta IS NOT NULL AND h.quantity_delta <> 0
          AND i.is_active = 1 AND ${notAVariantParent('i.id')} AND ${notUnlimited('i.is_unlimited')};`,
      [windowStart, now],
    );
    const events: ValuationEvent[] = eventRows.map((r) => ({
      createdAt: r.created_at,
      valueDelta:
        r.quantity_delta *
        // Same precedence as the anchor: a manual current value wins over the replacement cost,
        // so reversing the ledger lands on a past total measured the same way as today's.
        effectiveUnitValue(
          r.current_value,
          effectiveUnitCost({ unitCost: r.unit_cost, preferredSupplierCost: r.preferred_supplier_cost }),
        ),
    }));

    return buildValuationTrend(currentValue, events, windowStart, now, points);
  }

  // Phase 77 — data-hygiene / quality report -------------------------------------

  /**
   * Data-hygiene report (§3): per active, non-parent item, the quality flags the pure
   * {@link buildHygieneReport} folds into "tidy up" sections — missing category / real location /
   * price / photo, never cycle-counted, stale, and possible duplicates (shared MPN). All flags
   * are correlated sub-queries over data already stored (`item_images`, `item_history`,
   * `supplier_parts`); the cost fallback reuses {@link preferredSupplierCostSql} and the
   * variant-parent exclusion reuses {@link notAVariantParent}. No schema change. `now` defaults to
   * the wall clock; `staleDays` sets the "no activity for this long" cutoff.
   */
  async dataHygiene(staleDays: number, now: number = nowMs()): Promise<HygieneReport> {
    const base = this.baseCurrency();
    const rows = await this.driver.query<{
      id: string;
      name: string;
      mpn: string | null;
      category_id: string | null;
      location_id: string;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      has_photo: number;
      ever_counted: number;
      last_activity_at: number;
    }>(
      `SELECT i.id AS id, i.name AS name, i.mpn AS mpn, i.category_id AS category_id,
              i.location_id AS location_id, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id', base)} AS preferred_supplier_cost,
              (EXISTS (SELECT 1 FROM item_images im WHERE im.item_id = i.id)) AS has_photo,
              (EXISTS (SELECT 1 FROM item_history h WHERE h.item_id = i.id AND h.action = 'RECONCILED')) AS ever_counted,
              COALESCE((SELECT MAX(h.created_at) FROM item_history h WHERE h.item_id = i.id), i.created_at) AS last_activity_at
         FROM items i
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')};`,
    );

    const flags: HygieneItemFlags[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      mpn: r.mpn,
      hasCategory: r.category_id != null,
      hasLocation: r.location_id !== UNASSIGNED_LOCATION_ID,
      hasPrice: r.unit_cost != null || r.preferred_supplier_cost != null,
      hasPhoto: r.has_photo === 1,
      everCounted: r.ever_counted === 1,
      lastActivityAt: Number(r.last_activity_at),
    }));

    return buildHygieneReport(flags, { now, staleDays });
  }

  // Phase 79 — procurement / spend analytics -------------------------------------

  /**
   * Spend (cash out) over the trailing `windowDays`, bucketed into `buckets` equal spans and broken
   * down by source, supplier and category (§3). Composed from three sources already stored, each
   * **tagged** so the by-source view exposes any overlap (an item bought via a PO may also carry an
   * acquisition price): received purchase-order lines (`received_qty × unit_cost`, dated by the PO's
   * `ordered_at`/`created_at`), manual `project_expenses`, and item `purchase_price` at the parsed
   * `acquired_at`. The pure {@link buildSpendReport} owns all window/bucket/grouping maths; the
   * repository only fetches the raw events. No schema change. Distinct from the Phase-74
   * valuation-trend (that tracks inventory *value*; this tracks *money out*). `now` defaults to the
   * wall clock.
   *
   * **Purchase orders priced in another currency are excluded, not converted** (issue #285). A PO
   * carries its own `currency`, stored verbatim and never converted, so summing a $500 order into
   * a £ total would report a spend figure that is simply wrong — in the headline, and in the
   * by-supplier and by-category breakdowns alike. They are left out on the same terms as a foreign
   * supplier price ({@link inBaseCurrencySql}), and the count is reported on the report so the
   * screen can show what was omitted rather than quietly understating the spend.
   */
  async spendAnalytics(windowDays: number, buckets: number, now: number = nowMs()): Promise<SpendReport> {
    const windowEnd = now;
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;
    const events: SpendEvent[] = [];
    // Resolved once per report so a change mid-report cannot split one total across two
    // currencies, exactly as `inventoryValue` does (#284).
    const base = this.baseCurrency();
    // Half-open window on the order's effective date, shared by the spend query and the
    // excluded-order count so the two can never disagree about what "in the window" means.
    const poWindowSql = `COALESCE(po.ordered_at, po.created_at) >= ? AND COALESCE(po.ordered_at, po.created_at) < ?`;

    // 1. Received purchase-order lines, dated by the order (no per-line receipt timestamp exists).
    const poRows = await this.driver.query<{
      instant: number;
      amount: number;
      supplier_id: string | null;
      supplier: string | null;
      category_id: string | null;
      category_name: string | null;
    }>(
      // The supplier breakdown resolves through `suppliers`, so every order placed with one
      // supplier rolls up under one heading: the name is now a property of a single supplier
      // record rather than free text copied onto each order, so the two spellings that used to
      // split a supplier's spend across two rows can no longer exist.
      `SELECT COALESCE(po.ordered_at, po.created_at) AS instant,
              l.received_qty * l.unit_cost AS amount,
              po.supplier_id AS supplier_id,
              s.name AS supplier,
              i.category_id AS category_id, c.name AS category_name
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
         JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN items i ON i.id = l.item_id
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE l.received_qty > 0 AND l.unit_cost IS NOT NULL
          AND ${poWindowSql}${base === null ? '' : ` AND ${inBaseCurrencySql('po.currency', base)}`};`,
      [windowStart, windowEnd],
    );
    for (const r of poRows) {
      events.push({
        instant: Number(r.instant),
        amount: Number(r.amount),
        source: 'PURCHASE_ORDER',
        supplierId: r.supplier_id,
        supplier: r.supplier,
        categoryId: r.category_id,
        categoryName: r.category_name,
      });
    }

    // 2. Manual project expenses (no supplier; project budget categories are a separate taxonomy).
    const expenseRows = await this.driver.query<{ instant: number; amount: number }>(
      `SELECT incurred_at AS instant, amount AS amount
         FROM project_expenses
        WHERE amount > 0 AND incurred_at >= ? AND incurred_at < ?;`,
      [windowStart, windowEnd],
    );
    for (const r of expenseRows) {
      events.push({
        instant: Number(r.instant),
        amount: Number(r.amount),
        source: 'PROJECT_EXPENSE',
        supplierId: null,
        supplier: null,
        categoryId: null,
        categoryName: null,
      });
    }

    // 3. Item acquisition prices. `acquired_at` is ISO TEXT (no numeric instant), so the precise
    // half-open window filter is applied in JS after `parseAcquiredAt`. A coarse lexical lower-bound
    // pre-filter (`acquired_at >= <windowStart − 1 day, as YYYY-MM-DD>`) bounds the scan to roughly
    // the window without dropping any valid row (ISO-8601 dates sort lexically; the one-day margin
    // covers the timezone-less date → UTC-midnight parse). The pure seam re-applies the exact filter.
    const acquiredLowerBound = new Date(windowStart - MS_PER_DAY).toISOString().slice(0, 10);
    const acquisitionRows = await this.driver.query<{
      amount: number;
      acquired_at: string | null;
      category_id: string | null;
      category_name: string | null;
    }>(
      `SELECT i.purchase_price AS amount, i.acquired_at AS acquired_at,
              i.category_id AS category_id, c.name AS category_name
         FROM items i
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.purchase_price IS NOT NULL AND i.acquired_at IS NOT NULL
          AND i.acquired_at >= ?;`,
      [acquiredLowerBound],
    );
    for (const r of acquisitionRows) {
      const instant = parseAcquiredAt(r.acquired_at);
      if (instant === null) continue;
      events.push({
        instant,
        amount: Number(r.amount),
        source: 'ACQUISITION',
        supplierId: null,
        supplier: null,
        categoryId: r.category_id,
        categoryName: r.category_name,
      });
    }

    // How many in-window orders the currency filter dropped. Every condition the spend query
    // applies *other* than the currency one is repeated here — the window, the supplier join, and
    // the "has a received, priced line" test — so the count names exactly the orders whose money
    // the currency filter removed, and no others. In particular the `suppliers` join must stay an
    // inner one: an order whose supplier has been deleted (`supplier_id` SET NULL) contributes no
    // spend regardless of its currency, so counting it here would report money as missing that was
    // never in the total to begin with. 0 when the base currency is unknown, since nothing was
    // excluded in that case.
    let excludedForeignCurrency = 0;
    if (base !== null) {
      const row = await this.driver.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
          WHERE ${poWindowSql}
            AND NOT ${inBaseCurrencySql('po.currency', base)}
            AND EXISTS (SELECT 1 FROM purchase_order_lines l
                         WHERE l.po_id = po.id AND l.received_qty > 0 AND l.unit_cost IS NOT NULL);`,
        [windowStart, windowEnd],
      );
      excludedForeignCurrency = row?.n ?? 0;
    }

    return buildSpendReport(
      events,
      windowStart,
      windowEnd,
      buckets,
      excludedForeignCurrency,
      this.moneyDecimals(),
    );
  }

  /**
   * Sales & disposal analytics (Sales & disposals capability): sale proceeds vs a cost snapshot
   * (→ margin) plus written-off stock value over a trailing window. Reads the immutable
   * `item_history` ledger's `SOLD` / `WRITTEN_OFF` rows — each of which recorded its proceeds
   * (`net_value_delta`) and a per-line cost snapshot in `metadata` — and hands them to the pure
   * {@link buildSalesReport}, which owns all window/bucket/margin maths. No schema change; the
   * metadata JSON is parsed in JS (driver-agnostic) rather than via `json_extract`. `now` defaults
   * to the wall clock.
   */
  async salesAnalytics(windowDays: number, buckets: number, now: number = nowMs()): Promise<SalesReport> {
    const windowEnd = now;
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;

    const rows = await this.driver.query<{
      instant: number;
      action: string;
      quantity_delta: number | null;
      net_value_delta: number | null;
      metadata: string | null;
      category_id: string | null;
      category_name: string | null;
    }>(
      `SELECT h.created_at AS instant, h.action AS action, h.quantity_delta AS quantity_delta,
              h.net_value_delta AS net_value_delta, h.metadata AS metadata,
              i.category_id AS category_id, c.name AS category_name
         FROM item_history h
         JOIN items i ON i.id = h.item_id
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE h.action IN ('SOLD', 'WRITTEN_OFF')
          AND h.created_at >= ? AND h.created_at < ?;`,
      [windowStart, windowEnd],
    );

    // Resolved once rather than per row — it is the same base currency for every line, and the
    // per-line cost below runs inside the map.
    const decimals = this.moneyDecimals();
    const events: SalesEvent[] = rows.map((r) => {
      const meta = parseSalesMetadata(r.metadata);
      // Prefer the metadata quantity; fall back to the ledger delta's magnitude.
      const quantity = meta.quantity ?? Math.abs(Number(r.quantity_delta ?? 0));
      const unitCost = meta.unitCostAtSale;
      // The line's proceeds were quantised to the minor unit when the sale was recorded, so its
      // cost is quantised the same way here — otherwise the margin subtracts an unrounded
      // subtrahend from a rounded minuend and lands a penny out (issue #288).
      const cost = unitCost === null ? null : roundMoney(unitCost * quantity, decimals);
      return {
        instant: Number(r.instant),
        kind: r.action === 'WRITTEN_OFF' ? 'WRITTEN_OFF' : 'SOLD',
        quantity,
        proceeds: Number(r.net_value_delta ?? 0),
        cost,
        categoryId: r.category_id,
        categoryName: r.category_name,
      };
    });

    return buildSalesReport(events, windowStart, windowEnd, buckets, decimals);
  }
}

/** The sale/write-off metadata fields the report reads, tolerant of a malformed/absent blob. */
function parseSalesMetadata(raw: string | null): { quantity: number | null; unitCostAtSale: number | null } {
  if (!raw) return { quantity: null, unitCostAtSale: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const quantity =
      typeof parsed.quantity === 'number' && Number.isFinite(parsed.quantity) ? parsed.quantity : null;
    const unitCostAtSale =
      typeof parsed.unitCostAtSale === 'number' && Number.isFinite(parsed.unitCostAtSale)
        ? parsed.unitCostAtSale
        : null;
    return { quantity, unitCostAtSale };
  } catch {
    return { quantity: null, unitCostAtSale: null };
  }
}
