/**
 * Dashboard feed reads (spec §3 "Soon to Expire" / "Low Stock Alerts", §4). Read-only
 * projections over the item table that power the dashboard widgets and surface the
 * items needing attention soonest.
 */
import { LOW_STOCK_GAUGE_PERCENT, LOW_STOCK_QTY_THRESHOLD } from '../constants';
import type { HistoryAction } from '../constants';
import { addCalendarDays } from '@/lib/calendar-days';
import { todayDateInputValue } from '@/lib/date-input';
import type { SqlValue } from '../../rpc/driver';
import { rowToActivityFeedEntry, rowToFieldDueDate, rowToItem } from '../mappers';
import type {
  ActivityFeedEntry,
  ActivityFeedRow,
  FieldDueDate,
  FieldDueDateRow,
  Item,
  ItemRow,
  LowStockThresholds,
  Page,
  PageParams,
} from '../types';
import { ITEM_READ_COLUMNS } from './sql';
import { expiringPredicateSql, lowStockPredicateSql, warrantyExpiringPredicateSql } from './attention-sql';
import { ITEM_STATUS_FILTERS, buildStatusFilter, type ItemStatusFilter } from './status-filter';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';
import { nowMs } from '@/lib/clock';

/** Tuning for {@link ItemFeedRepository.applicableStatuses} (mirrors the list's status filter). */
export interface ApplicableStatusParams {
  /** Injected clock (UNIX-ms) for the time-based statuses; defaults to `nowMs()`. */
  readonly now?: number;
  readonly lowStockThresholds?: LowStockThresholds;
  readonly expirySoonWindowDays?: number;
  /**
   * Scope applicability to a single location (the sidebar selection), so the filter bar only
   * offers filters that match **within the currently-viewed location**. Omit/null for the
   * "All items" view (whole inventory).
   */
  readonly locationId?: string | null;
  /**
   * The candidate statuses to test — only these get an `EXISTS` column computed, so a status
   * whose module is off never runs its (sometimes heavy) probe for a result the filter bar
   * would never show. The caller passes the feature-enabled subset (always including the
   * always-on core stock statuses) resolved via {@link STATUS_FILTER_FEATURE}. Omitted =
   * test all {@link ITEM_STATUS_FILTERS}. An empty array short-circuits to an empty result
   * without a query.
   */
  readonly candidates?: readonly ItemStatusFilter[];
}

/** One status filter's current match count (0 = not applicable — the chip has nothing to show). */
export interface ItemStatusCount {
  readonly status: ItemStatusFilter;
  readonly count: number;
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
     * How many active items currently match each of the common status filters — the inventory
     * filter bar uses this both to hide a chip that matches nothing (spec §3 filter axis) and
     * to show the match count in its label (e.g. "Out of stock (8)"). Computed in a **single
     * pass over `items`** — one conditional `SUM(CASE WHEN … THEN 1 ELSE 0 END)` per status
     * rather than a scalar `(SELECT COUNT(*) FROM items …)` subquery each, which would scan
     * the table once per candidate status (issue #166: up to seven scans on every filter-bar
     * render at 100k items). Each status still reuses its SSOT predicate via
     * {@link buildStatusFilter}, so the count can never disagree with what the filter would
     * actually return. `now` is injected for the time-based statuses (defaulting to query time).
     *
     * When `locationId` is set the counts are scoped to that location, so switching the
     * sidebar selection recomputes them — a filter that matches nothing *in the current
     * location* counts as zero even if it would match elsewhere.
     *
     * `candidates` narrows which statuses are probed at all: the caller passes only the
     * feature-enabled subset (via {@link STATUS_FILTER_FEATURE}), so a status whose module is
     * off never has its count computed — some of those probes are the heaviest (the
     * maintenance correlated subquery, the unindexed warranty scan) and their result would be
     * discarded anyway, as the filter bar hides that chip. Omitted = probe every status. Only
     * statuses with a non-zero count are returned, in canonical {@link ITEM_STATUS_FILTERS}
     * order (not the caller's candidate order) so the result is order-stable for the query cache.
     */
    async applicableStatuses(params: ApplicableStatusParams = {}): Promise<ItemStatusCount[]> {
      const candidates = params.candidates ?? ITEM_STATUS_FILTERS;
      // No candidates (every status's module off) → nothing to probe; skip the round-trip
      // entirely rather than issue a degenerate `SELECT;`.
      if (candidates.length === 0) return [];
      const ctx = {
        now: params.now ?? nowMs(),
        lowStockThresholds: params.lowStockThresholds,
        expirySoonWindowDays: params.expirySoonWindowDays,
      };
      const columns: string[] = [];
      const sqlParams: SqlValue[] = [];
      candidates.forEach((status, i) => {
        const [clause, clauseParams] = buildStatusFilter([status], ctx);
        columns.push(`SUM(CASE WHEN ${clause} THEN 1 ELSE 0 END) AS s${i}`);
        sqlParams.push(...clauseParams);
      });
      // The active-only / location scope moves to the shared `WHERE`, so it is applied once for
      // the whole pass instead of being repeated inside every status's own subquery. Its bound
      // value therefore comes *after* all the SELECT-list params, matching SQL clause order.
      const scope = params.locationId ? ' AND location_id = ?' : '';
      if (params.locationId) sqlParams.push(params.locationId);
      // `SUM(...)` over zero matching rows is SQL NULL (not 0), so the column type admits null
      // and the `?? 0` below is load-bearing for an empty/absent-location inventory.
      const row = await this.driver.queryOne<Record<string, number | null>>(
        `SELECT ${columns.join(', ')} FROM items WHERE is_active = 1${scope};`,
        sqlParams,
      );
      // Collect the non-zero counts, then return them in canonical ITEM_STATUS_FILTERS order
      // (not the caller's candidate order) so the result is order-stable for the query cache.
      const countByStatus = new Map(candidates.map((status, i) => [status, Number(row?.[`s${i}`] ?? 0)]));
      return ITEM_STATUS_FILTERS.filter((status) => (countByStatus.get(status) ?? 0) > 0).map((status) => ({
        status,
        count: countByStatus.get(status)!,
      }));
    }

    /**
     * The category ids that at least one **active** item currently uses — the set the
     * inventory Category facet offers (issue #76). The facet is a declutter of the full
     * category catalogue in exactly the way the status chips are: it should list only
     * categories that would actually match something, not every category ever defined. A
     * category with no items (never used, or emptied by moving/removing its last item) is
     * dropped, and it reappears the moment an item is put back into it.
     *
     * When `locationId` is set the set is scoped to that location, mirroring the list's own
     * `location_id = ?` scope (and {@link applicableStatuses}), so switching the sidebar
     * selection recomputes it — a category counts as "in use" only within the currently-viewed
     * location. Omit/null for the "All items" view (whole inventory). Uncategorised items
     * (`category_id IS NULL`) contribute nothing. Order is not significant (the caller joins
     * these ids against the named category catalogue), so the raw `DISTINCT` order is returned.
     */
    async categoriesInUse(locationId?: string | null): Promise<string[]> {
      const scope = locationId ? ' AND location_id = ?' : '';
      const params: SqlValue[] = locationId ? [locationId] : [];
      const rows = await this.driver.query<{ category_id: string }>(
        `SELECT DISTINCT category_id FROM items
         WHERE is_active = 1 AND category_id IS NOT NULL${scope};`,
        params,
      );
      return rows.map((r) => r.category_id);
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
        `SELECT ${ITEM_READ_COLUMNS} FROM items
         WHERE is_active = 1 AND ${expiringPredicateSql()}
         ORDER BY expiry_date ASC LIMIT ? OFFSET ?;`,
        [before, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }

    /** Convenience: perishables expiring within `withinDays` of `now` (inclusive). */
    async listExpiringWithin(withinDays: number, now: number, params: PageParams = {}): Promise<Page<Item>> {
      return this.listExpiring(addCalendarDays(now, withinDays), params);
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
        `SELECT ${ITEM_READ_COLUMNS} FROM items
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
      const cutoff = new Date(addCalendarDays(now, withinDays)).toISOString().slice(0, 10);
      const rows = await this.driver.query<ItemRow>(
        // The warranty predicate is shared with the inventory list's status filter — see
        // `attention-sql.ts` — so the alert-centre feed and the filter can never diverge.
        `SELECT ${ITEM_READ_COLUMNS} FROM items
         WHERE is_active = 1 AND ${warrantyExpiringPredicateSql()}
         ORDER BY warranty_expires_at ASC, name COLLATE NOCASE ASC
         LIMIT ? OFFSET ?;`,
        [cutoff, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }

    /**
     * Active items carrying a value for a custom `DATE` field whose **definition has opted in
     * as a due date** (W1a) — the alert-centre and Upcoming-agenda "custom field date" lanes.
     * Ordered soonest-first, then by item and field name so the order is stable.
     *
     * Until this existed a custom `DATE` field was inert: readable everywhere, actionable
     * nowhere, so a user-defined "Renewal date" raised nothing. The opt-in is
     * `field_defs.due_lead_days` — null means an ordinary date and is skipped here.
     *
     * **Reads the `item_field_effective_values` VIEW, not `item_field_values`.** An item whose
     * value is inherited from its location stores NULL in the base table, so reading the base
     * table would silently miss every inheriting item (issue #97) — the same reason the search
     * layer's `field:` predicate reads the view.
     *
     * **The window.** Each row is compared against *its own definition's* lead time —
     * `value <= date(:today, '+' || due_lead_days || ' days')`, which is exactly "the due day
     * is within N calendar days of today" and so agrees day-for-day with the pure
     * `fieldDueStatus` classifier that grades what comes back. Already-passed dates are
     * included (they are `<= today`, and an overdue deadline is the one most worth raising).
     * `withinDays` overrides every definition's lead time with one shared horizon — how the
     * agenda asks for *everything* scheduled rather than only what is imminent.
     *
     * Values are stored as canonical `YYYY-MM-DD` TEXT, so ISO string comparison orders and
     * bounds them correctly. The `GLOB` guard skips anything not of that shape: values are
     * validated on write, but a row can also arrive from a peer or a restored snapshot, and a
     * malformed one must be ignored rather than compared as a string against a real date.
     *
     * The `date(value) = value` companion is an **equality**, not a null check: SQLite's `date()`
     * silently *normalises* an impossible day rather than rejecting it (`2026-02-30` comes back as
     * `2026-03-02`), so a null test would admit the row and then report a date the user never
     * entered. Comparing against the input accepts only a canonical, real calendar day — which is
     * also what makes `Date.parse` total in the mapper, and so what keeps the page's `hasMore`
     * honest, since nothing has to be dropped after the read.
     *
     * Abstract variant parents are deliberately **not** excluded here, unlike the stock and
     * warranty predicates. Those exclude a parent because it holds no stock of its own; a date
     * is not stock, and a licence or inspection recorded against the parent is a real deadline.
     *
     * The `(item_id, def_id)` tail on the ORDER BY makes it **total**, which the three
     * human-meaningful keys are not — two items can share a name, and then carry the same field
     * with the same date. Both callers walk this by `LIMIT`/`OFFSET` across every page
     * (`readAllPages`), and an under-determined order can repeat or skip a row at a page
     * boundary; the view's grain makes that pair unique, so it settles every tie.
     *
     * Binds, in order: `[todayIso, withinDays ?? null, limit, offset]`.
     */
    async listFieldDueDates(
      now: number,
      params: PageParams & { readonly withinDays?: number } = {},
    ): Promise<Page<FieldDueDate>> {
      const { limit, offset } = this.resolvePage(params);
      // The *local* calendar day, not a UTC slice of `now`: the window is "within N days of
      // today", and which day it is today is a wall-clock question (see `todayDateInputValue`).
      const today = todayDateInputValue(now);
      const rows = await this.driver.query<FieldDueDateRow>(
        `SELECT i.id AS item_id, i.name AS item_name,
                fd.id AS def_id, fd.name AS field_name,
                fd.due_lead_days AS due_lead_days, efv.value AS value
         FROM item_field_effective_values efv
         JOIN field_defs fd ON fd.id = efv.def_id
         JOIN items i ON i.id = efv.item_id
         WHERE i.is_active = 1
           AND fd.due_lead_days IS NOT NULL
           AND efv.value IS NOT NULL
           AND efv.value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           AND date(efv.value) = efv.value
           AND efv.value <= date(?, '+' || COALESCE(?, fd.due_lead_days) || ' days')
         ORDER BY efv.value ASC, i.name COLLATE NOCASE ASC, fd.name COLLATE NOCASE ASC,
                  efv.item_id ASC, efv.def_id ASC
         LIMIT ? OFFSET ?;`,
        [today, params.withinDays ?? null, limit, offset],
      );
      return this.toPage(rows.map(rowToFieldDueDate), limit, offset);
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

    /**
     * Total number of {@link getHistoryFeed} rows for the same `actions` filter — powers the
     * Activity feed's page count when the feed is shown paginated (issue #20). Mirrors the feed's
     * `WHERE` exactly (same `action IN (…)` clause, same `items` join) so the count can never
     * disagree with the pages it sizes; an explicit empty `actions` array is "match nothing" → 0.
     */
    async countHistoryFeed(filters: Pick<ActivityFeedFilters, 'actions'> = {}): Promise<number> {
      const actions = filters.actions;
      if (actions !== undefined && actions.length === 0) return 0;
      const where =
        actions && actions.length > 0 ? `WHERE h.action IN (${actions.map(() => '?').join(', ')})` : '';
      const row = await this.driver.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n
         FROM item_history h
         JOIN items i ON i.id = h.item_id
         ${where};`,
        [...(actions ?? [])],
      );
      return Number(row?.n ?? 0);
    }
  };
}
