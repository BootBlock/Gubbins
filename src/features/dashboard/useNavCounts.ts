/**
 * useNavCounts — the "how many are in there" badge counts for the dashboard nav tiles.
 *
 * Each counted destination shows a small right-aligned count on its {@link DashboardNav}
 * card ("Projects → 3"), so the hub doubles as an at-a-glance summary. Only the
 * *collection* screens carry a count — the ones that are naturally "N of a thing" — and
 * each uses its domain's own idea of what's worth counting rather than a raw row total:
 *
 * | Destination      | Default count                                                     |
 * | ---------------- | ----------------------------------------------------------------- |
 * | Inventory        | every item in the catalogue                                       |
 * | Projects         | *active* projects (not COMPLETED / ARCHIVED)                      |
 * | Purchase orders  | *open* orders (DRAFT / ORDERED / PARTIAL — not RECEIVED/CANCELLED) |
 * | Contacts         | every contact                                                     |
 * | Bookings         | *upcoming* bookings (not cancelled/converted, not yet ended)      |
 *
 * The Inventory / Projects / Purchase-orders / Bookings tiles are **configurable** (backlog
 * A1): the user can re-point them at a different metric from Settings → Dashboard. The choice
 * is a Tier-2 preference (`navCountMetrics`); the available metrics, their labels, spoken nouns
 * and attention tone are the `NAV_COUNT_METRIC_CONFIG` SSOT. Most metrics are a **pure selector**
 * over the same rows the tile's read hook already loads — so switching costs no extra fetch.
 *
 * A subset are **"problem" metrics** (backlog A2) that count something needing attention, so the
 * pill takes a warning/danger tone instead of the group hue (`tone` on the resolved
 * {@link NavCount}; {@link DashboardNav} maps it to a token). These read a small dedicated count
 * query — Projects → *over-budget* via `useBudgetAlerts`, Inventory → *low-stock* via
 * `useLowStockCount` (a true count, not the 100-capped list) / *out-of-stock* via
 * `useOutOfStockCount` — each **gated so it only fetches when that metric is the tile's current
 * choice**. (Purchase-order "overdue" is deliberately absent: a PO has no expected-delivery
 * column, so it is not derivable.) Contacts stays single-metric, so it has no picker.
 *
 * Feeds (Upcoming / Activity) and the settings-y System tiles carry no count; Alerts keeps
 * its own dedicated attention badge in {@link DashboardNav}. A destination is omitted from
 * the returned map until its query has data, so a card never flashes a stale/`0` while its
 * count is still loading — and a genuine `0` is dropped by the caller (nothing to show).
 *
 * The reads reuse the existing per-domain hooks (same query keys → shared cache, no extra
 * fetch when a widget already loaded them), and the "what counts as active/open/…" filters
 * live here so {@link DashboardNav} stays pure presentation.
 */
import { useBookings } from '@/features/bookings/bookings';
import { useContacts } from '@/features/contacts/contacts';
import { useItemCount } from '@/features/inventory/queries';
import { projectBudgetHealth, type BudgetAlertFigures } from '@/features/projects/budget';
import { useBudgetAlerts, useProjects } from '@/features/projects/projects';
import { usePurchaseOrders } from '@/features/purchasing/queries';
import { useLowStockCount, useOutOfStockCount } from '@/features/reports/queries';
import {
  navCountOption,
  normaliseNavCountMetric,
  type NavCountRoute,
  type NavCountTone,
} from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { AppRoutePath } from '@/components/nav/nav-destinations';
import { nowMs } from '@/lib/clock';
import { MS_PER_DAY } from '@/db/repositories/constants';
import { startOfUtcDay } from '@/lib/calendar-days';

/** One counted tile's badge: the figure, the spoken nouns and the attention tone. */
export interface NavCount {
  readonly count: number;
  /** Singular spoken noun ("active project"), pluralised with the count at the call site. */
  readonly noun: string;
  /** Plural spoken noun ("active projects") — the irregular form for phrase nouns. */
  readonly nounPlural: string;
  /**
   * Attention tone for the pill (backlog A2): `'neutral'` shows the tile's group hue, while a
   * problem metric shows `'warning'` / `'danger'`. The tone is decorative — the spoken count
   * on the tile's accessible name always states *what* the number is.
   */
  readonly tone: NavCountTone;
}

/**
 * The instant at the start of today — the cut-off for a booking still being upcoming. Taken in UTC
 * because bookings store midnight UTC (issue #320), so the comparison against `startDate`/`endDate`
 * stays in one time frame.
 */
function startOfToday(): number {
  return startOfUtcDay(nowMs());
}

// --- pure count selectors: (rows, metric) → count -----------------------------
// Each operates only on rows the tile's existing read hook already loaded (bounded sets
// fetched whole at `limit: 100`), so the badge matches exactly what the destination shows.

type ProjectRow = { readonly status: string };
type PurchaseOrderRow = { readonly effectiveStatus: string };
type BookingRow = {
  readonly startDate: number;
  readonly endDate: number;
  readonly cancelledAt: number | null;
  readonly convertedCheckoutId: string | null;
};
/** Projects: all projects, or only the *active* ones (default — not finished or shelved). */
export function countProjects(rows: readonly ProjectRow[], metric: string): number {
  if (metric === 'all') return rows.length;
  return rows.filter((p) => p.status !== 'COMPLETED' && p.status !== 'ARCHIVED').length;
}

/**
 * Projects over budget (backlog A2): count of budgeted projects whose spend so far or projected
 * final cost has passed the budget. Shares {@link projectBudgetHealth} with the Dashboard
 * "Budget alerts" widget, so the count and the widget can never drift; `listBudgetAlerts` already
 * returns only budgeted projects.
 *
 * @internal Exported for unit tests only.
 */
export function countOverBudgetProjects(rows: readonly BudgetAlertFigures[], warnPercent: number): number {
  return rows.filter((a) => projectBudgetHealth(a, warnPercent).over).length;
}

/** Purchase orders: all orders, or only the *open* ones (default — not RECEIVED / CANCELLED). */
export function countPurchaseOrders(rows: readonly PurchaseOrderRow[], metric: string): number {
  if (metric === 'all') return rows.length;
  return rows.filter((po) => po.effectiveStatus !== 'RECEIVED' && po.effectiveStatus !== 'CANCELLED').length;
}

/**
 * Bookings: every booking, only those *starting this week* (the next 7 days), or the
 * *upcoming* ones (default). A live booking is one neither cancelled nor converted to a loan;
 * dates are midnight-UTC day-start UNIX-ms, so "upcoming" compares the last day against the start of
 * today (an all-day booking is still upcoming on its final day) and "this week" is a rolling 7-day
 * window from the start of today.
 */
export function countBookings(rows: readonly BookingRow[], metric: string): number {
  if (metric === 'all') return rows.length;
  const live = rows.filter((b) => !b.cancelledAt && !b.convertedCheckoutId);
  if (metric === 'thisWeek') {
    const start = startOfToday();
    // Seven UTC days from the start of today. A UTC day is exactly MS_PER_DAY (no DST), so the window
    // edge stays on a UTC midnight aligned with the stored booking dates (issue #320).
    const end = start + 7 * MS_PER_DAY;
    return live.filter((b) => b.startDate >= start && b.startDate < end).length;
  }
  const cutoff = startOfToday();
  return live.filter((b) => b.endDate >= cutoff).length;
}

/** Build a tile's {@link NavCount} from its resolved metric and computed count (carries the tone). */
function navCountFor(route: NavCountRoute, metric: string, count: number): NavCount {
  const opt = navCountOption(route, metric);
  return { count, noun: opt.noun, nounPlural: opt.nounPlural, tone: opt.tone ?? 'neutral' };
}

/** Resolve a configurable tile's current metric and build its {@link NavCount} from a row selector. */
function configurable(
  route: NavCountRoute,
  metrics: Record<NavCountRoute, string>,
  count: (metric: string) => number,
): NavCount {
  const metric = normaliseNavCountMetric(route, metrics[route] ?? '');
  return navCountFor(route, metric, count(metric));
}

/**
 * The badge per counted destination, keyed by route. A key is present only once its source
 * query has resolved; absent while loading. Counts may be `0` — the caller decides whether a
 * `0` is worth a badge (it isn't).
 */
export function useNavCounts(): Partial<Record<AppRoutePath, NavCount>> {
  const metrics = usePreferencesStore((s) => s.navCountMetrics);
  const budgetWarnPercent = usePreferencesStore((s) => s.budgetWarnPercent);

  // Resolve the configurable tiles whose metric may need a *dedicated* count query up front,
  // so those queries can be gated on the choice — an unselected problem metric must not fetch.
  const inventoryMetric = normaliseNavCountMetric('/inventory', metrics['/inventory'] ?? '');
  const projectsMetric = normaliseNavCountMetric('/projects', metrics['/projects'] ?? '');

  const itemCount = useItemCount();
  const lowStock = useLowStockCount({ enabled: inventoryMetric === 'lowStock' });
  const outOfStock = useOutOfStockCount({ enabled: inventoryMetric === 'outOfStock' });
  const projects = useProjects();
  const budgetAlerts = useBudgetAlerts({ enabled: projectsMetric === 'overBudget' });
  const purchaseOrders = usePurchaseOrders();
  const contacts = useContacts();
  const bookings = useBookings();

  const counts: Partial<Record<AppRoutePath, NavCount>> = {};

  // Inventory — the item total (default) or an A2 problem metric. Exactly one source is active
  // for the chosen metric; the tile appears only once that source has resolved.
  if (inventoryMetric === 'lowStock') {
    if (typeof lowStock.data === 'number') {
      counts['/inventory'] = navCountFor('/inventory', inventoryMetric, lowStock.data);
    }
  } else if (inventoryMetric === 'outOfStock') {
    if (typeof outOfStock.data === 'number') {
      counts['/inventory'] = navCountFor('/inventory', inventoryMetric, outOfStock.data);
    }
  } else if (typeof itemCount.data === 'number') {
    counts['/inventory'] = navCountFor('/inventory', inventoryMetric, itemCount.data);
  }

  // Projects — a row selector (active / all), or the over-budget count from the budget feed.
  if (projectsMetric === 'overBudget') {
    if (budgetAlerts.data) {
      counts['/projects'] = navCountFor(
        '/projects',
        projectsMetric,
        countOverBudgetProjects(budgetAlerts.data, budgetWarnPercent),
      );
    }
  } else if (projects.data) {
    counts['/projects'] = navCountFor(
      '/projects',
      projectsMetric,
      countProjects(projects.data.rows, projectsMetric),
    );
  }

  if (purchaseOrders.data) {
    counts['/purchase-orders'] = configurable('/purchase-orders', metrics, (m) =>
      countPurchaseOrders(purchaseOrders.data.rows, m),
    );
  }

  if (contacts.data) {
    counts['/contacts'] = {
      count: contacts.data.rows.length,
      noun: 'contact',
      nounPlural: 'contacts',
      tone: 'neutral',
    };
  }

  if (bookings.data) {
    counts['/bookings'] = configurable('/bookings', metrics, (m) => countBookings(bookings.data.rows, m));
  }

  return counts;
}
