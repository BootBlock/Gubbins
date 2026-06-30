/**
 * ReportRepository — read-only aggregations for the §3 Reports & valuation screen
 * (inventory-depth Phase 61). No schema change: every figure is a projection over data
 * already stored (`items`, `item_stock`, `item_history`, `categories`, `locations`).
 *
 * The repository runs the SQL and hands the minimal raw rows to the pure helpers in
 * `@/features/reports/reports`, which own all bucketing/grouping/boundary maths (and are
 * unit-tested there). Cost lookups go through a single `effectiveUnitCost` seam in that
 * module, so a later phase can swap in the preferred-supplier cost without touching these
 * queries. Reads are unpaginated *aggregates* (a fixed, tiny result set), not row dumps.
 */
import { BaseRepository } from './base';
import {
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  MS_PER_DAY,
} from './constants';
import {
  bucketMovement,
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
import type { LowStockThresholds } from './types';

/** Default number of time buckets for the movement report (a fortnight of days fits well). */
const DEFAULT_MOVEMENT_BUCKETS = 14;

/**
 * SQL fragment excluding abstract variant **parents** (an item that has children holds no
 * stock of its own — its variants do), mirroring `listLowStock`. `col` is the qualified id
 * column to test (e.g. `i.id` in a joined query). Keeps the headline/category valuation,
 * the low-stock count and the dead-stock query in agreement.
 */
function notAVariantParent(col: string): string {
  return `${col} NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)`;
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
    }>(
      `SELECT i.category_id AS category_id, c.name AS category_name, i.quantity AS quantity, i.unit_cost AS unit_cost
         FROM items i
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.is_active = 1 AND ${notAVariantParent('i.id')};`,
    );

    const itemValuations: ItemValuationRow[] = itemRows.map((r) => ({
      quantity: r.quantity,
      unitCost: r.unit_cost,
    }));
    const categoryRows: ValuationRow[] = itemRows.map((r) => ({
      groupId: r.category_id,
      groupName: r.category_name,
      quantity: r.quantity,
      unitCost: r.unit_cost,
    }));

    // Per-location: the `item_stock` ledger (where stock actually sits), costed by the item.
    const stockRows = await this.driver.query<{
      location_id: string;
      location_name: string | null;
      quantity: number;
      unit_cost: number | null;
    }>(
      `SELECT s.location_id AS location_id, l.name AS location_name, s.quantity AS quantity, i.unit_cost AS unit_cost
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
      created_at: number;
      last_moved_at: number | null;
    }>(
      `SELECT i.id AS id, i.name AS name, i.quantity AS quantity, i.unit_cost AS unit_cost,
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
      lastMovedAt: r.last_moved_at,
      createdAt: r.created_at,
    }));
    return selectDeadStock(candidates, sinceDays, now);
  }
}
