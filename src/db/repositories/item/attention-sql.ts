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
 */

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
    AND id NOT IN (SELECT parent_id FROM items WHERE parent_id IS NOT NULL)
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
