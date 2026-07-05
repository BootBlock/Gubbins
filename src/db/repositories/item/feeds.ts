/**
 * Dashboard feed reads (spec §3 "Soon to Expire" / "Low Stock Alerts", §4). Read-only
 * projections over the item table that power the dashboard widgets and surface the
 * items needing attention soonest.
 */
import { LOW_STOCK_GAUGE_PERCENT, LOW_STOCK_QTY_THRESHOLD, MS_PER_DAY } from '../constants';
import type { HistoryAction } from '../constants';
import type { SqlValue } from '../../rpc/driver';
import { rowToActivityFeedEntry, rowToItem } from '../mappers';
import type {
  ActivityFeedEntry,
  ActivityFeedRow,
  Item,
  ItemRow,
  LowStockThresholds,
  Page,
  PageParams,
} from '../types';
import { THUMBNAIL_SUBQUERY } from './sql';
import { expiringPredicateSql, lowStockPredicateSql, warrantyExpiringPredicateSql } from './attention-sql';
import { ITEM_STATUS_FILTERS, buildStatusFilter, type ItemStatusFilter } from './status-filter';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** Tuning for {@link ItemFeedRepository.applicableStatuses} (mirrors the list's status filter). */
export interface ApplicableStatusParams {
  /** Injected clock (UNIX-ms) for the time-based statuses; defaults to `Date.now()`. */
  readonly now?: number;
  readonly lowStockThresholds?: LowStockThresholds;
  readonly expirySoonWindowDays?: number;
}

/** Filters for the cross-item global activity feed (Phase 80). */
export interface ActivityFeedFilters extends PageParams {
  /**
   * Restrict the feed to these history actions. Omitted or empty = the full feed
   * (no `WHERE`), so the common "show everything" case never builds a 21-placeholder
   * `IN (…)`. The screen derives this list from the enabled kind chips.
   */
  readonly actions?: readonly HistoryAction[];
}

export function withDashboardFeeds<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemFeedRepository extends Base {
    /**
     * Which of the common status filters currently match **at least one** active item — the
     * inventory filter bar hides the rest so it only offers filters that would do something
     * (spec §3 filter axis). Computed in a single round-trip: one `SELECT` of a boolean
     * `EXISTS(…)` per status, each reusing that status's SSOT predicate via
     * {@link buildStatusFilter}, so applicability can never disagree with what the filter
     * would actually return. `now` is injected for the time-based statuses (defaulting to
     * query time). Every `EXISTS` short-circuits on its first match, so this stays cheap even
     * on a large catalogue.
     */
    async applicableStatuses(params: ApplicableStatusParams = {}): Promise<ItemStatusFilter[]> {
      const ctx = {
        now: params.now ?? Date.now(),
        lowStockThresholds: params.lowStockThresholds,
        expirySoonWindowDays: params.expirySoonWindowDays,
      };
      const columns: string[] = [];
      const sqlParams: SqlValue[] = [];
      ITEM_STATUS_FILTERS.forEach((status, i) => {
        const [clause, clauseParams] = buildStatusFilter([status], ctx);
        columns.push(`EXISTS(SELECT 1 FROM items WHERE is_active = 1 AND ${clause}) AS s${i}`);
        sqlParams.push(...clauseParams);
      });
      const row = await this.driver.queryOne<Record<string, number>>(
        `SELECT ${columns.join(', ')};`,
        sqlParams,
      );
      return ITEM_STATUS_FILTERS.filter((_, i) => Number(row?.[`s${i}`] ?? 0) === 1);
    }

    /**
     * Active perishable items expiring on or before `before` (a UNIX-ms cutoff,
     * typically `now + N days`), soonest first — the §3 "Soon to Expire" widget feed.
     * Already-expired items are included (their expiry is in the past, ≤ cutoff).
     */
    async listExpiring(before: number, params: PageParams = {}): Promise<Page<Item>> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<ItemRow>(
        // The expiry predicate is shared with the inventory list's status filter — see
        // `attention-sql.ts` — so the widget feed and the filter can never diverge.
        `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
         WHERE is_active = 1 AND ${expiringPredicateSql()}
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
     * own — its variants do), **unlimited-supply items** (an infinite source never runs
     * low, Phase 82 — matching the pure `isLow` guard) and inactive items.
     *
     * **Low-stock is opt-in — an effective floor of 0 is "off".** Each row's effective
     * floor is its own `reorder_point` / `reorder_gauge_percent` when set, else the
     * passed-in global threshold. A row is only considered when that floor is *strictly
     * positive* (`COALESCE(...) > 0`), so with the global default off (0) nothing is
     * flagged until the item is opted in with its own positive reorder point — and an
     * explicit per-item 0 opts a single item back out even when the blanket is on. This
     * matches the pure {@link isLow} guard. Thresholds default to
     * {@link LOW_STOCK_QTY_THRESHOLD} / {@link LOW_STOCK_GAUGE_PERCENT} (both 0 = off).
     */
    async listLowStock(thresholds: LowStockThresholds = {}, params: PageParams = {}): Promise<Page<Item>> {
      const qty = thresholds.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
      const pct = thresholds.gaugePercent ?? LOW_STOCK_GAUGE_PERCENT;
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<ItemRow>(
        // The low-stock predicate is shared with the inventory list's status filter — see
        // `attention-sql.ts` (`COALESCE(reorder_point, :qty)` resolves each row's effective
        // floor; the `> 0` guard makes a 0 floor mean "off"/opt-in). The qty ordering below
        // divides by `MAX(effectiveFloor, 1)` to avoid a divide-by-zero (belt-and-braces —
        // a 0-floor row is already excluded by the predicate, so ordering never sees it).
        `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
         WHERE is_active = 1 AND ${lowStockPredicateSql()}
         ORDER BY
           CASE WHEN tracking_mode = 'CONSUMABLE_GAUGE' THEN current_net_value / gross_capacity
                ELSE CAST(quantity AS REAL) / MAX(COALESCE(reorder_point, ?), 1) END ASC,
           name COLLATE NOCASE ASC
         LIMIT ? OFFSET ?;`,
        [qty, qty, pct, pct, qty, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }

    /**
     * Active items with a `warranty_expires_at` date set whose warranty has either
     * already expired or will expire within `withinDays` of `now` — the alert-centre
     * warranty lane (Phase 68, spec §3). Ordered soonest-expiry first.
     *
     * Only items with the Phase-66 column populated are returned; items without a
     * warranty date are excluded (they produce no warranty alert, per spec). The
     * `withinDays` window should match {@link WARRANTY_EXPIRING_SOON_DAYS} from
     * `asset-lifecycle.ts` so the SQL pre-filter and the pure status function agree.
     */
    async listWarrantyExpiring(
      withinDays: number,
      now: number,
      params: PageParams = {},
    ): Promise<Page<Item>> {
      const { limit, offset } = this.resolvePage(params);
      // ISO date string for now + window. `warranty_expires_at` is stored as TEXT
      // 'YYYY-MM-DD' so ISO-ordered string comparison gives correct date ordering.
      // We include items already past expiry (warranty_expires_at <= today) as well
      // as those expiring within the window (warranty_expires_at <= cutoff date).
      const cutoff = new Date(now + withinDays * MS_PER_DAY).toISOString().slice(0, 10);
      const rows = await this.driver.query<ItemRow>(
        // The warranty predicate is shared with the inventory list's status filter — see
        // `attention-sql.ts` — so the alert-centre feed and the filter can never diverge.
        `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items
         WHERE is_active = 1 AND ${warrantyExpiringPredicateSql()}
         ORDER BY warranty_expires_at ASC, name COLLATE NOCASE ASC
         LIMIT ? OFFSET ?;`,
        [cutoff, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }

    /**
     * The cross-item global Activity Log (Phase 80) — every `item_history` entry across
     * all items, newest-first, joined to `items` for the owning item's name + active
     * flag. This is the global counterpart to the per-item {@link getHistory}; both order
     * by `created_at DESC, rowid DESC` so same-millisecond inserts keep a deterministic
     * order. Strictly paginated (§2.1) and bounded by the virtualised list window, so the
     * feed stays light against 100,000+ ledger rows.
     *
     * Pruned rows are physically removed from `item_history`
     * ({@link StorageRepository.pruneHistoryBefore}), so reading the table already honours
     * the §7.6.3-A prune watermark — that watermark is a *sync* concern, not a read filter.
     *
     * `actions` restricts the feed to a subset of history actions for the kind-filter
     * chips. The empty-array sentinel is unambiguous: **omitted** (`undefined`) returns
     * the full feed (no `WHERE`), while an **explicit empty array** matches nothing — so
     * de-selecting every kind chip shows an empty feed rather than silently falling back
     * to everything.
     */
    async getHistoryFeed(filters: ActivityFeedFilters = {}): Promise<Page<ActivityFeedEntry>> {
      const { limit, offset } = this.resolvePage(filters);
      const actions = filters.actions;
      // An explicit empty filter list means "match nothing" — return early without a query.
      if (actions !== undefined && actions.length === 0) {
        return this.toPage([], limit, offset);
      }
      const where =
        actions && actions.length > 0 ? `WHERE h.action IN (${actions.map(() => '?').join(', ')})` : '';
      const rows = await this.driver.query<ActivityFeedRow>(
        `SELECT h.*, i.name AS item_name, i.is_active AS item_is_active
         FROM item_history h
         JOIN items i ON i.id = h.item_id
         ${where}
         ORDER BY h.created_at DESC, h.rowid DESC
         LIMIT ? OFFSET ?;`,
        [...(actions ?? []), limit, offset],
      );
      return this.toPage(rows.map(rowToActivityFeedEntry), limit, offset);
    }
  };
}
