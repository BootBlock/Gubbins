/**
 * Inventory list **status filters** — the common "attention" filters the inventory screen
 * exposes as toggle chips: *Low stock*, *Expiring*, *Overdue* and *Maintenance due* (spec
 * §3 dashboard feeds / §4 alerts, surfaced as a list filter).
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
  MS_PER_DAY,
  WARRANTY_SOON_WINDOW_DAYS,
} from '../constants';
import type { LowStockThresholds } from '../types';
import { onLoanCheckoutExistsSql, overdueCheckoutExistsSql } from '../CheckoutRepository';
import { maintenanceDueExistsSql } from '../MaintenanceRepository';
import {
  expiringPredicateSql,
  lowStockPredicateSql,
  outOfStockPredicateSql,
  warrantyExpiringPredicateSql,
} from './attention-sql';

/** The common attention filters, in canonical (stable) order. */
export type ItemStatusFilter =
  'low-stock' | 'out-of-stock' | 'expiring' | 'warranty' | 'on-loan' | 'overdue' | 'maintenance-due';

/** Every status filter, in the order they are OR-combined and displayed. */
export const ITEM_STATUS_FILTERS: readonly ItemStatusFilter[] = [
  'low-stock',
  'out-of-stock',
  'expiring',
  'warranty',
  'on-loan',
  'overdue',
  'maintenance-due',
];

const STATUS_FILTER_SET = new Set<string>(ITEM_STATUS_FILTERS);

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
    case 'expiring': {
      const windowDays = ctx.expirySoonWindowDays ?? EXPIRY_SOON_WINDOW_DAYS;
      return [expiringPredicateSql(), [ctx.now + windowDays * MS_PER_DAY]];
    }
    case 'warranty': {
      // `warranty_expires_at` is a TEXT YYYY-MM-DD date, so bind an ISO date-string cutoff.
      const cutoff = new Date(ctx.now + WARRANTY_SOON_WINDOW_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
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
