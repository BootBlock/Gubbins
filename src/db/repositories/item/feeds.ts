/**
 * Dashboard feed reads (spec §3 "Soon to Expire" / "Low Stock Alerts", §4). Read-only
 * projections over the item table that power the dashboard widgets and surface the
 * items needing attention soonest.
 */
import {
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  MS_PER_DAY,
} from '../constants';
import { rowToItem } from '../mappers';
import type { Item, ItemRow, LowStockThresholds, Page, PageParams } from '../types';
import { THUMBNAIL_SUBQUERY } from './sql';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withDashboardFeeds<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemFeedRepository extends Base {
    /**
     * Active perishable items expiring on or before `before` (a UNIX-ms cutoff,
     * typically `now + N days`), soonest first — the §3 "Soon to Expire" widget feed.
     * Already-expired items are included (their expiry is in the past, ≤ cutoff).
     */
    async listExpiring(before: number, params: PageParams = {}): Promise<Page<Item>> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<ItemRow>(
        `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
         WHERE is_active = 1 AND expiry_date IS NOT NULL AND expiry_date <= ?
         ORDER BY expiry_date ASC LIMIT ? OFFSET ?;`,
        [before, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }

    /** Convenience: perishables expiring within `withinDays` of `now` (inclusive). */
    async listExpiringWithin(withinDays: number, now: number, params: PageParams = {}): Promise<Page<Item>> {
      return this.listExpiring(now + withinDays * MS_PER_DAY, params);
    }

    /**
     * Active items running low — the §3 dashboard "Low Stock Alerts" feed, most
     * depleted first. A DISCRETE item is low when on-hand `quantity` is at/below its
     * effective quantity floor; a CONSUMABLE_GAUGE item is low when its percentage
     * remaining is at/below its effective gauge floor (§4 "low-stock alerts based on
     * percentage or remaining weight rather than integer counts").
     *
     * **Per-item reorder points (Phase 59).** Each row's floor is its *own*
     * `reorder_point` / `reorder_gauge_percent` when set, falling back per row to the
     * passed-in global threshold via `COALESCE` — so a part with a bespoke minimum is
     * judged against it while everything else still uses the global default. The
     * ordering fraction divides by the same effective floor so the two tracking modes
     * interleave by genuine urgency relative to *their own* trigger.
     *
     * SERIALISED single assets are excluded (a qty-1 asset isn't "low bulk stock"), as
     * are **abstract variant parents** (an item that has children holds no stock of its
     * own — its variants do) and inactive items. Thresholds default to
     * {@link LOW_STOCK_QTY_THRESHOLD} / {@link LOW_STOCK_GAUGE_PERCENT}.
     */
    async listLowStock(thresholds: LowStockThresholds = {}, params: PageParams = {}): Promise<Page<Item>> {
      const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
      const pct = thresholds.gaugePercent ?? LOW_STOCK_GAUGE_PERCENT;
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<ItemRow>(
        // `COALESCE(reorder_point, :qty)` resolves each row's effective floor. The qty
        // ordering divides by `MAX(effectiveFloor, 1)` to avoid a divide-by-zero when an
        // item's own reorder point is 0 (a valid "only flag when truly empty" setting).
        `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
         WHERE is_active = 1
           AND id NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)
           AND (
             (tracking_mode = 'DISCRETE' AND quantity <= COALESCE(reorder_point, ?))
             OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0
                 AND current_net_value <= gross_capacity * COALESCE(reorder_gauge_percent, ?) / 100.0)
           )
         ORDER BY
           CASE WHEN tracking_mode = 'CONSUMABLE_GAUGE' THEN current_net_value / gross_capacity
                ELSE CAST(quantity AS REAL) / MAX(COALESCE(reorder_point, ?), 1) END ASC,
           name COLLATE NOCASE ASC
         LIMIT ? OFFSET ?;`,
        [qty, pct, qty, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }
  };
}
