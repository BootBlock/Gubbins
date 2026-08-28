/**
 * Inventory list **status filters** — the common "attention" filters the inventory screen
 * exposes as toggle chips: *Low stock*, *On order*, *Expiring*, *Overdue* and *Maintenance
 * due* (spec §3 dashboard feeds / §4 alerts, surfaced as a list filter).
 *
 * Each status maps to a boolean SQL fragment scoped to the outer `FROM items` query. The
 * fragments are *not* re-defined here — they are imported from each concept's SSOT
 * ({@link lowStockPredicateSql} / {@link expiringPredicateSql} in `attention-sql.ts`, and the
 * correlated `EXISTS` helpers on the checkout & maintenance repositories) so the list filter
 * can never drift from the dashboard widgets and alert centre that use the same predicates.
 *
 * Multiple selected statuses are **OR-combined** (an "attention" view: show items matching
 * *any* selected concern), then the whole group is AND-ed into the list's `WHERE` alongside
 * the location / search / active-only filters by {@link buildListFilter}.
 */
import type { FeatureId } from '@/features/modules/feature-registry';
import type { SqlValue } from '../../rpc/driver';
import {
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  WARRANTY_SOON_WINDOW_DAYS,
} from '../constants';
import { localDayWindowCutoff } from '@/lib/calendar-days';
import { toDateInputValue } from '@/lib/date-input';
import type { LowStockThresholds } from '../types';
import { onLoanCheckoutExistsSql, overdueCheckoutExistsSql } from '../CheckoutRepository';
import { maintenanceDueExistsSql } from '../MaintenanceRepository';
import { onOrderQtyForItemSql } from '../PurchaseOrderRepository';
import {
  expiringPredicateSql,
  lowStockPredicateSql,
  outOfStockPredicateSql,
  warrantyExpiringPredicateSql,
} from './attention-sql';

/** The common attention filters, in canonical (stable) order. */
export type ItemStatusFilter =
  | 'low-stock'
  | 'out-of-stock'
  | 'on-order'
  | 'expiring'
  | 'warranty'
  | 'on-loan'
  | 'overdue'
  | 'maintenance-due';

/** Every status filter, in the order they are OR-combined and displayed. */
export const ITEM_STATUS_FILTERS: readonly ItemStatusFilter[] = [
  'low-stock',
  'out-of-stock',
  // Sits beside the two stock-level filters because it answers the same question from the
  // other side: not "how little is on the shelf" but "how much is already on its way".
  'on-order',
  'expiring',
  'warranty',
  'on-loan',
  'overdue',
  'maintenance-due',
];

const STATUS_FILTER_SET = new Set<string>(ITEM_STATUS_FILTERS);

/**
 * The statuses whose match count is a function of an item's **stock level** — i.e. the only
 * ones a stock-only write (the quantity stepper, a gauge adjust) can move.
 *
 * *Low stock* and *out of stock* read `quantity` / `current_net_value` off the `items` row, so
 * adding or drawing down stock can flip an item in or out of them. *Expiring* joins them for a
 * different reason (issue #684): it is judged on the item's **effective** expiry, which includes
 * the earliest date across the lots that still hold stock, so receiving a dated lot or consuming
 * the last of one moves the count even though no date changed. Every *other* status is decided by
 * a field or a table a stock write never touches: `warranty_expires_at` on the row, or the
 * purchase-order, checkout and maintenance tables.
 *
 * This is the SSOT for the split applicability queries (`useApplicableStatuses`): the five
 * stock-independent counts are cached under their own key so a stepper tap doesn't recompute
 * them, and they are the expensive ones — each carries a correlated per-row subquery. Keep this
 * list honest: a status added here that *isn't* purely stock-derived would show a stale count
 * after an unrelated write, and one wrongly left out merely costs the recompute it was meant to
 * skip. See {@link ITEM_STATUS_FILTERS} for the full set.
 */
export const STOCK_DEPENDENT_STATUSES: readonly ItemStatusFilter[] = [
  'low-stock',
  'out-of-stock',
  'expiring',
];

const STOCK_DEPENDENT_SET = new Set<ItemStatusFilter>(STOCK_DEPENDENT_STATUSES);

/** Whether a stock-only write can change this status's match count (see {@link STOCK_DEPENDENT_STATUSES}). */
export function isStockDependentStatus(status: ItemStatusFilter): boolean {
  return STOCK_DEPENDENT_SET.has(status);
}

/** Narrow an arbitrary string to a known {@link ItemStatusFilter}. */
export function isItemStatusFilter(value: string): value is ItemStatusFilter {
  return STATUS_FILTER_SET.has(value);
}

/**
 * The Modular-UI capability each status filter needs to be enabled for that filter to be
 * offered — the SSOT for both the filter-bar chip gating ({@link InventoryFilterBar}) and
 * the applicability query's candidate set ({@link useApplicableStatuses}), so the two can
 * never disagree about which statuses a reduced module set exposes. Statuses absent from
 * the map (*low stock*, *out of stock*) are always-on core inventory — never gated. When a
 * status's module is off the filter bar hides its chip **and** the applicability query skips
 * its `EXISTS` probe (some are heavy — the maintenance correlated subquery, the unindexed
 * warranty scan), so no work is spent computing a result the user can never see.
 */
export const STATUS_FILTER_FEATURE: Partial<Record<ItemStatusFilter, FeatureId>> = {
  'on-order': 'purchase-orders',
  expiring: 'perishables',
  warranty: 'warranty',
  'on-loan': 'contacts',
  overdue: 'contacts',
  'maintenance-due': 'maintenance',
};

/** Contextual inputs the time/threshold-sensitive predicates need. */
export interface StatusFilterContext {
  /** Injected clock (UNIX-ms) for the time-based statuses (expiring / overdue / maintenance). */
  readonly now: number;
  /** Global low-stock fallback floors; defaults to the built-in off (0) thresholds. */
  readonly lowStockThresholds?: LowStockThresholds;
  /** Window (days) for the "expiring" status; defaults to {@link EXPIRY_SOON_WINDOW_DAYS}. */
  readonly expirySoonWindowDays?: number;
}

/** Resolve one status to its SQL fragment + bound params (in SQL order). */
function predicateFor(status: ItemStatusFilter, ctx: StatusFilterContext): [sql: string, params: SqlValue[]] {
  switch (status) {
    case 'low-stock': {
      const qty = ctx.lowStockThresholds?.qtyThreshold ?? LOW_STOCK_QTY_THRESHOLD;
      const pct = ctx.lowStockThresholds?.gaugePercent ?? LOW_STOCK_GAUGE_PERCENT;
      return [lowStockPredicateSql(), [qty, qty, pct, pct]];
    }
    case 'out-of-stock':
      return [outOfStockPredicateSql(), []];
    case 'on-order':
      // Reuses the purchase-order repository's own scalar so "on order" here can never mean
      // something different from the "N on order" the reorder editor and Low Stock widget show.
      return [`(${onOrderQtyForItemSql('items.id')} > 0)`, []];
    case 'expiring': {
      const windowDays = ctx.expirySoonWindowDays ?? EXPIRY_SOON_WINDOW_DAYS;
      // The boundary is `windowDays` whole calendar days on from the viewer's *today*, in the
      // midnight-UTC frame `expiry_date` is stored in — the same call `expiryStatus` classifies
      // with, so the chip's match count is stable across the day rather than widening by one day
      // each evening west of UTC (issue #498).
      return [expiringPredicateSql(), [localDayWindowCutoff(ctx.now, windowDays)]];
    }
    case 'warranty': {
      // `warranty_expires_at` is a TEXT YYYY-MM-DD date, so bind an ISO date-string cutoff — the
      // same calendar-day boundary as the expiring chip above, read back as the day it names.
      const cutoff = toDateInputValue(localDayWindowCutoff(ctx.now, WARRANTY_SOON_WINDOW_DAYS));
      return [warrantyExpiringPredicateSql(), [cutoff]];
    }
    case 'on-loan':
      return [onLoanCheckoutExistsSql(), []];
    case 'overdue':
      return [overdueCheckoutExistsSql(), [ctx.now]];
    case 'maintenance-due':
      return [maintenanceDueExistsSql(), [ctx.now, ctx.now]];
  }
}

/**
 * Build the OR-combined status-filter clause + params for {@link buildListFilter}.
 *
 * Statuses are emitted in the canonical {@link ITEM_STATUS_FILTERS} order (not the caller's
 * selection order) so the generated SQL — and therefore the query cache key upstream — is
 * stable regardless of the order chips were toggled. Duplicates and unknown values are
 * ignored. An empty selection yields an empty clause (no filtering).
 */
export function buildStatusFilter(
  statuses: readonly ItemStatusFilter[],
  ctx: StatusFilterContext,
): [clause: string, params: SqlValue[]] {
  const selected = new Set(statuses);
  const fragments: string[] = [];
  const params: SqlValue[] = [];
  for (const status of ITEM_STATUS_FILTERS) {
    if (!selected.has(status)) continue;
    const [sql, sqlParams] = predicateFor(status, ctx);
    fragments.push(sql);
    params.push(...sqlParams);
  }
  if (fragments.length === 0) return ['', []];
  return [`(${fragments.join(' OR ')})`, params];
}
