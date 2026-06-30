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
import {
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  MS_PER_DAY,
} from './constants';
import {
  bucketMovement,
  effectiveUnitCost,
  groupValuation,
  selectDeadStock,
  summariseConsumption,
  summariseValuation,
  type ConsumptionRateReport,
  type DeadStockCandidate,
  type DeadStockReport,
  type InventoryValueReport,
  type ItemValuationRow,
  type MovementEvent,
  type MovementReport,
  type ValuationRow,
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
import {
  buildReorderPlan,
  type ReorderPlanGroup,
  type ReorderShortfallRow,
} from '@/features/purchasing/reorder-plan';
import type { LowStockThresholds } from './types';

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
 * stock of its own — its variants do), mirroring `listLowStock`. `col` is the qualified id
 * column to test (e.g. `i.id` in a joined query). Keeps the headline/category valuation,
 * the low-stock count and the dead-stock query in agreement.
 */
function notAVariantParent(col: string): string {
  return `${col} NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)`;
}

/**
 * Correlated subquery yielding the **preferred** supplier part's `unit_cost` for an item
 * (NULL when none is marked or the preferred row is unpriced). Feeds the `preferredSupplierCost`
 * fallback so valuation honours the Phase-60 cost precedence — a manual `items.unit_cost` wins,
 * else the preferred supplier cost — resolved in one place by `effectiveUnitCost`
 * (`@/features/reports/reports`). `col` is the qualified item-id column to correlate on. At most
 * one preferred row exists per item (repository invariant); the `ORDER BY` is a defensive
 * tiebreak for a malformed multi-preferred state.
 */
function preferredSupplierCostSql(col: string): string {
  return `(SELECT sp.unit_cost FROM supplier_parts sp
             WHERE sp.item_id = ${col} AND sp.is_preferred = 1
             ORDER BY sp.updated_at DESC LIMIT 1)`;
}

export class ReportRepository extends BaseRepository {
  /**
   * Inventory valuation (§3): the overall `SUM(quantity × effectiveUnitCost)`, the count of
   * unpriced active items, and the value broken down **by category** and **by location**.
   * The headline + category breakdown read `items.quantity` (the item's whole on-hand
   * count); the location breakdown reads the per-location `item_stock` ledger so stock split
   * across drawers is valued where it physically sits. Active, non-parent items only.
   */
  async inventoryValue(): Promise<InventoryValueReport> {
    // Headline + per-category: one row per active, non-parent item with its category.
    const itemRows = await this.driver.query<{
      category_id: string | null;
      category_name: string | null;
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
    }>(
      `SELECT i.category_id AS category_id, c.name AS category_name, i.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost
         FROM items i
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')};`,
    );

    const itemValuations: ItemValuationRow[] = itemRows.map((r) => ({
      quantity: r.quantity,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
    }));
    const categoryRows: ValuationRow[] = itemRows.map((r) => ({
      groupId: r.category_id,
      groupName: r.category_name,
      quantity: r.quantity,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
    }));

    // Per-location: the `item_stock` ledger (where stock actually sits), costed by the item.
    const stockRows = await this.driver.query<{
      location_id: string;
      location_name: string | null;
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
    }>(
      `SELECT s.location_id AS location_id, l.name AS location_name, s.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost
         FROM item_stock s
         JOIN items i ON i.id = s.item_id
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE i.is_active = 1 AND s.quantity > 0;`,
    );
    const locationRows: ValuationRow[] = stockRows.map((r) => ({
      groupId: r.location_id,
      groupName: r.location_name,
      quantity: r.quantity,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
    }));

    const headline = summariseValuation(itemValuations);
    return {
      ...headline,
      byCategory: groupValuation(categoryRows),
      byLocation: groupValuation(locationRows),
    };
  }

  /**
   * Consumption rate (§3) over the trailing `windowDays`: the total units consumed and the
   * mean per-day, drawn from `item_history` **negative** quantity deltas (a stock-out) and
   * gauge net-value reductions. `windowEnd` defaults to `now`.
   */
  async consumptionRate(windowDays: number, now: number = Date.now()): Promise<ConsumptionRateReport> {
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
    now: number = Date.now(),
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
   * `ItemRepository.listLowStock`, surfaced as a headline count. DISCRETE items at/below the
   * quantity threshold and CONSUMABLE_GAUGE items at/below the percentage threshold;
   * SERIALISED singles and abstract variant parents are excluded.
   */
  async lowStockCount(thresholds: LowStockThresholds = {}): Promise<number> {
    const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
    const pct = thresholds.gaugePercent ?? LOW_STOCK_GAUGE_PERCENT;
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM items
        WHERE is_active = 1
          AND id NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)
          AND (
            (tracking_mode = 'DISCRETE' AND quantity <= ?)
            OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0
                AND current_net_value <= gross_capacity * ? / 100.0)
          );`,
      [qty, pct],
    );
    return row?.n ?? 0;
  }

  /**
   * Dead stock (§3): active items holding stock that have **not moved in `sinceDays`**, with
   * the capital tied up. "Last moved" is the most recent `item_history` entry that changed
   * quantity or gauge value; an item that has never moved falls back to its `created_at`. The
   * boundary is inclusive (idle for exactly `sinceDays` qualifies); see `selectDeadStock`.
   */
  async deadStock(sinceDays: number, now: number = Date.now()): Promise<DeadStockReport> {
    const rows = await this.driver.query<{
      id: string;
      name: string;
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
      created_at: number;
      last_moved_at: number | null;
    }>(
      `SELECT i.id AS id, i.name AS name, i.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost,
              i.created_at AS created_at,
              ( SELECT MAX(h.created_at) FROM item_history h
                 WHERE h.item_id = i.id
                   AND (h.quantity_delta IS NOT NULL OR h.net_value_delta IS NOT NULL) ) AS last_moved_at
         FROM items i
        WHERE i.is_active = 1
          AND i.quantity > 0
          AND ${notAVariantParent('i.id')};`,
    );
    const candidates: DeadStockCandidate[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      quantity: r.quantity,
      unitCost: r.unit_cost,
      preferredSupplierCost: r.preferred_supplier_cost,
      lastMovedAt: r.last_moved_at,
      createdAt: r.created_at,
    }));
    return selectDeadStock(candidates, sinceDays, now);
  }

  /**
   * Low-stock shortfall rows joined to each item's preferred supplier-part (Phase 65).
   *
   * Mirrors the `listLowStock` SQL predicate (same `COALESCE(reorder_point, ?)` floor,
   * same DISCRETE-only restriction — CONSUMABLE_GAUGE items have no countable order unit)
   * and joins the single preferred `supplier_parts` row for each item so the caller can
   * immediately feed the result into {@link buildReorderPlan} without a second round-trip.
   *
   * The shortfall is `COALESCE(reorder_qty, COALESCE(reorder_point, ?) - quantity)` —
   * i.e. the per-item explicit top-up amount when set, else the distance from on-hand to
   * the effective floor (matching `shortfall()` in `reorder-policy.ts`).
   */
  async listReorderShortfall(thresholds: LowStockThresholds = {}): Promise<ReorderShortfallRow[]> {
    const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
    const rows = await this.driver.query<{
      item_id: string;
      item_name: string;
      shortfall: number;
      supplier_part_id: string | null;
      supplier_name: string | null;
      unit_cost: number | null;
      pack_qty: number | null;
      min_order_qty: number | null;
    }>(
      // Only DISCRETE items with countable shortfall (CONSUMABLE_GAUGE has no countable
      // top-up unit); SERIALISED singles and abstract variant parents are excluded as in
      // listLowStock. The LEFT JOIN brings the preferred supplier-part row — NULL when
      // none is marked preferred.
      `SELECT i.id AS item_id,
              i.name AS item_name,
              COALESCE(
                i.reorder_qty,
                MAX(0, COALESCE(i.reorder_point, ?) - i.quantity)
              ) AS shortfall,
              sp.id          AS supplier_part_id,
              sp.supplier_name,
              sp.unit_cost,
              sp.pack_qty,
              sp.min_order_qty
         FROM items i
         LEFT JOIN supplier_parts sp
                ON sp.item_id = i.id AND sp.is_preferred = 1
        WHERE i.is_active = 1
          AND i.tracking_mode = 'DISCRETE'
          AND i.quantity <= COALESCE(i.reorder_point, ?)
          AND i.id NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)
        ORDER BY (CAST(i.quantity AS REAL) / MAX(COALESCE(i.reorder_point, ?), 1)) ASC,
                 i.name COLLATE NOCASE ASC;`,
      [qty, qty, qty],
    );

    return rows.map((r) => ({
      itemId: r.item_id,
      itemName: r.item_name,
      shortfall: Number(r.shortfall),
      preferredSupplier: r.supplier_part_id
        ? {
            supplierPartId: r.supplier_part_id,
            supplierName: r.supplier_name!,
            unitCost: r.unit_cost,
            packQty: r.pack_qty,
            minOrderQty: r.min_order_qty,
          }
        : null,
    }));
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
  async abcAnalysis(
    windowDays: number = DEFAULT_ABC_WINDOW_DAYS,
    now: number = Date.now(),
  ): Promise<AbcReport> {
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
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost,
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
  async turnover(windowDays: number, now: number = Date.now()): Promise<TurnoverReport> {
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
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost,
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
  async stockAging(now: number = Date.now()): Promise<StockAgingReport> {
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
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost,
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
   * total (`SUM(quantity × effectiveUnitCost)`) anchors the line; the pure
   * {@link buildValuationTrend} helper reverses the value-tagged ledger from it. Each in-window
   * `item_history` quantity delta is costed by its item here (so the single cost-precedence rule
   * stays in {@link effectiveUnitCost}). Active, non-parent items only. `now` defaults to the
   * wall clock.
   */
  async valuationTrend(
    windowDays: number,
    points: number,
    now: number = Date.now(),
  ): Promise<ValuationTrendReport> {
    const windowStart = now - Math.max(1, windowDays) * MS_PER_DAY;

    // Current total value — the anchor the trend is reconstructed backward from.
    const itemRows = await this.driver.query<{
      quantity: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
    }>(
      `SELECT i.quantity AS quantity, i.unit_cost AS unit_cost,
              ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost
         FROM items i
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')};`,
    );
    const currentValue = summariseValuation(
      itemRows.map((r) => ({
        quantity: r.quantity,
        unitCost: r.unit_cost,
        preferredSupplierCost: r.preferred_supplier_cost,
      })),
    ).totalValue;

    // Value-tagged ledger events inside the window (half-open at the start; inclusive of now).
    const eventRows = await this.driver.query<{
      created_at: number;
      quantity_delta: number;
      unit_cost: number | null;
      preferred_supplier_cost: number | null;
    }>(
      `SELECT h.created_at AS created_at, h.quantity_delta AS quantity_delta,
              i.unit_cost AS unit_cost, ${preferredSupplierCostSql('i.id')} AS preferred_supplier_cost
         FROM item_history h
         JOIN items i ON i.id = h.item_id
        WHERE h.created_at > ? AND h.created_at <= ?
          AND h.quantity_delta IS NOT NULL AND h.quantity_delta <> 0
          AND i.is_active = 1 AND ${notAVariantParent('i.id')};`,
      [windowStart, now],
    );
    const events: ValuationEvent[] = eventRows.map((r) => ({
      createdAt: r.created_at,
      valueDelta:
        r.quantity_delta *
        effectiveUnitCost({ unitCost: r.unit_cost, preferredSupplierCost: r.preferred_supplier_cost }),
    }));

    return buildValuationTrend(currentValue, events, windowStart, now, points);
  }
}
