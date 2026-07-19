/**
 * Shared item-table "attention" SQL predicates (spec §3 dashboard feeds, §4 alerts).
 *
 * Two derived-status conditions are computable purely from the `items` row — *running
 * low* and *expiring* — and are needed in two places: the dashboard feed reads
 * ({@link withDashboardFeeds}) and the inventory list's status filter
 * ({@link buildStatusFilter}). Rather than let those two drift, the predicate SQL lives
 * here once and both sites import it. Each builder returns an `items`-scoped boolean
 * fragment; the caller supplies the bound parameters in the documented order.
 *
 * The cross-table statuses (checkout *overdue*, *maintenance due*) are owned by their own
 * repositories — see `CheckoutRepository.overdueCheckoutExistsSql` and
 * `MaintenanceRepository.maintenanceDueExistsSql` — because they correlate against those
 * tables. Together the four cover the common inventory attention filters.
 *
 * Every fragment here is `items`-scoped and references the outer row as `items.…`, so the
 * caller's query must select from an **unaliased** `items` table.
 */

/**
 * "This item is not an abstract variant parent" — an item with children holds no stock of
 * its own, so it never runs low, runs out, or raises a warranty alert on its own account.
 * `col` is the **qualified** id column of the outer row to test (e.g. `items.id`, or `i.id`
 * in a joined query); it must be qualified, since a bare `id` would resolve against this
 * subquery's own table rather than the outer one.
 *
 * A correlated `NOT EXISTS` rather than `NOT IN (SELECT parent_id …)`. `NOT IN` makes SQLite
 * materialise the whole parent-id set into an ephemeral list on every execution (`EXPLAIN
 * QUERY PLAN`: `LIST SUBQUERY` + `CREATE BLOOM FILTER`); `NOT EXISTS` instead probes
 * `idx_items_parent_id` once per candidate row (`SEARCH child USING COVERING INDEX
 * idx_items_parent_id (parent_id=?)`), so nothing is built up front — and these predicates
 * run constantly (the dashboard feeds and the inventory list's status filter). Measured over
 * a 200k-item table that is ~4× faster. It also drops the NULL-semantics footgun: `NOT IN`
 * against a set containing NULL matches nothing, which is why the old form needed a
 * hand-written `parent_id IS NOT NULL` guard.
 *
 * This is the SSOT for the exclusion — `ReportRepository` imports it too, so the attention
 * feeds, the status filter and the reports can never disagree about what "abstract parent"
 * means.
 */
export function notAVariantParentSql(col: string): string {
  return `NOT EXISTS (SELECT 1 FROM items child WHERE child.parent_id = ${col})`;
}

/**
 * "This item is running low", opt-in per §4 low-stock alerts. A DISCRETE item is low when
 * on-hand `quantity` is at/below its effective floor; a CONSUMABLE_GAUGE item is low when
 * its percentage remaining is at/below its effective gauge floor. Each row's floor is its
 * own `reorder_point` / `reorder_gauge_percent` when set, else the passed-in global
 * fallback — and only a *strictly positive* floor counts, so a 0 floor means "off"
 * (opt-in), matching the pure `isLow` guard. Abstract variant parents (items with children)
 * and unlimited-supply items are never low.
 *
 * Binds, in order: `[qtyThreshold, qtyThreshold, gaugePercent, gaugePercent]`.
 */
export function lowStockPredicateSql(): string {
  return `(is_unlimited = 0
    AND ${notAVariantParentSql('items.id')}
    AND (
      (tracking_mode = 'DISCRETE'
         AND COALESCE(reorder_point, ?) > 0
         AND quantity <= COALESCE(reorder_point, ?))
      OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0
          AND COALESCE(reorder_gauge_percent, ?) > 0
          AND current_net_value <= gross_capacity * COALESCE(reorder_gauge_percent, ?) / 100.0)
    ))`;
}

/**
 * "This perishable is expiring on or before the cutoff." Already-expired items are included
 * (their expiry is in the past, ≤ cutoff). Items with no expiry date never match.
 *
 * Binds, in order: `[cutoffMs]` — a UNIX-ms instant, typically `now + windowDays·MS_PER_DAY`.
 */
export function expiringPredicateSql(): string {
  return `(expiry_date IS NOT NULL AND expiry_date <= ?)`;
}

/**
 * "This item is out of stock." A DISCRETE item is out when on-hand `quantity` has reached
 * zero; a CONSUMABLE_GAUGE item is out when it is empty. Unlike low stock this is not opt-in
 * — nothing has to be configured for a depleted item to show. Abstract variant parents (they
 * hold no stock of their own) and unlimited-supply items are never "out"; SERIALISED and
 * UNTRACKED items are excluded (quantity is not a bulk stock level for them).
 *
 * Takes no bound parameters.
 */
export function outOfStockPredicateSql(): string {
  return `(is_unlimited = 0
    AND ${notAVariantParentSql('items.id')}
    AND (
      (tracking_mode = 'DISCRETE' AND quantity <= 0)
      OR (tracking_mode = 'CONSUMABLE_GAUGE' AND gross_capacity > 0 AND current_net_value <= 0)
    ))`;
}

/**
 * "This asset's warranty has expired or expires within the cutoff." `warranty_expires_at` is
 * stored as a TEXT `YYYY-MM-DD` date, so the cutoff is bound as an ISO date string and
 * ISO-ordered string comparison gives correct date ordering (mirrors `listWarrantyExpiring`).
 * Already-expired warranties are included (≤ cutoff). Assets without a warranty date, and
 * abstract variant parents, never match.
 *
 * Binds, in order: `[cutoffDate]` — a `YYYY-MM-DD` string, typically
 * `date(now + WARRANTY_SOON_WINDOW_DAYS days)`.
 */
export function warrantyExpiringPredicateSql(): string {
  return `(${notAVariantParentSql('items.id')}
    AND warranty_expires_at IS NOT NULL
    AND warranty_expires_at <= ?)`;
}
