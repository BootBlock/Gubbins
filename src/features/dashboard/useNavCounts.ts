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
 * and attention tone are the `NAV_COUNT_METRIC_CONFIG` SSOT.
 *
 * **Every metric is a true count, resolved by the database** (issue #573). It used to be a
 * selector over the rows the tile's own read hook had already loaded — but those hooks read a
 * single page of `MAX_PAGE_SIZE`, so the badge was really "how many of the first hundred rows
 * match". Contacts stuck at 100 for good; worse, the filtered tiles could read `0` because the
 * page boundary, not the collection, was empty — a hundred open purchase orders sitting behind a
 * hundred newer received ones, or every upcoming booking pushed off the page by a long history.
 * A badge on the hub is read as a fact about the whole collection, so each is now asked as a
 * `COUNT(*)` with its predicate pushed into SQL, exactly as Inventory's already were.
 *
 * A subset are **"problem" metrics** (backlog A2) that count something needing attention, so the
 * pill takes a warning/danger tone instead of the group hue (`tone` on the resolved
 * {@link NavCount}; {@link DashboardNav} maps it to a token) — Projects → *over-budget* via
 * `useBudgetAlerts`, Inventory → *low-stock* / *out-of-stock*. (Purchase-order "overdue" is
 * deliberately absent: a PO has no expected-delivery column, so it is not derivable.) Contacts
 * stays single-metric, so it has no picker.
 *
 * Where a tile's metric chooses between two count queries, the unselected one is **gated so it
 * never fetches**: a tile costs one small query, not one per metric it could have shown.
 *
 * Feeds (Upcoming / Activity) and the settings-y System tiles carry no count; Alerts keeps
 * its own dedicated attention badge in {@link DashboardNav}. A destination is omitted from
 * the returned map until its query has data, so a card never flashes a stale/`0` while its
 * count is still loading — and a genuine `0` is dropped by the caller (nothing to show).
 *
 * The reads reuse the existing per-domain count hooks (same query keys → shared cache, and the
 * domains' own writes already invalidate them), so {@link DashboardNav} stays pure presentation.
 */
import { useBookingCount, type BookingCountScope } from '@/features/bookings/bookings';
import { useContactCount } from '@/features/contacts/contacts';
import { useItemCount } from '@/features/inventory/queries';
import { projectBudgetHealth, type BudgetAlertFigures } from '@/features/projects/budget';
import { useBudgetAlerts, useProjectCount } from '@/features/projects/projects';
import { usePurchaseOrderCount } from '@/features/purchasing/queries';
import { useLowStockCount, useOutOfStockCount } from '@/features/reports/queries';
import {
  navCountOption,
  normaliseNavCountMetric,
  NAV_COUNT_METRIC_CONFIG,
  type NavCountRoute,
  type NavCountTone,
} from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { AppRoutePath } from '@/components/nav/nav-destinations';
import { ACTIVE_PROJECT_STATUSES, type ProjectFilter } from '@/db/repositories';

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

/** Build a tile's {@link NavCount} from its resolved metric and computed count (carries the tone). */
function navCountFor(route: NavCountRoute, metric: string, count: number): NavCount {
  const opt = navCountOption(route, metric);
  return { count, noun: opt.noun, nounPlural: opt.nounPlural, tone: opt.tone ?? 'neutral' };
}

/** The Bookings tile's metric ids, taken from the config rather than restated. */
type BookingsMetric = (typeof NAV_COUNT_METRIC_CONFIG)['/bookings']['options'][number]['value'];

/**
 * The booking-count scope each Bookings metric asks for — the one place the tile's vocabulary
 * ("thisWeek") meets the booking domain's ("startingThisWeek").
 *
 * The `satisfies` is what makes it total: adding a metric to `NAV_COUNT_METRIC_CONFIG` without
 * saying what it counts fails to compile here, rather than leaving a tile quietly showing the
 * upcoming count under a new label.
 */
const BOOKING_SCOPE_BY_METRIC: Record<string, BookingCountScope> = {
  all: 'all',
  upcoming: 'upcoming',
  thisWeek: 'startingThisWeek',
} satisfies Record<BookingsMetric, BookingCountScope>;

/**
 * The badge per counted destination, keyed by route. A key is present only once its source
 * query has resolved; absent while loading. Counts may be `0` — the caller decides whether a
 * `0` is worth a badge (it isn't).
 */
export function useNavCounts(): Partial<Record<AppRoutePath, NavCount>> {
  const metrics = usePreferencesStore((s) => s.navCountMetrics);
  const budgetWarnPercent = usePreferencesStore((s) => s.budgetWarnPercent);

  // Resolve every configurable tile's metric up front: each chooses *which* count query runs, and
  // the ones it did not choose are gated off so a tile costs one query rather than one per metric.
  const inventoryMetric = normaliseNavCountMetric('/inventory', metrics['/inventory'] ?? '');
  const projectsMetric = normaliseNavCountMetric('/projects', metrics['/projects'] ?? '');
  const purchaseOrdersMetric = normaliseNavCountMetric('/purchase-orders', metrics['/purchase-orders'] ?? '');
  const bookingsMetric = normaliseNavCountMetric('/bookings', metrics['/bookings'] ?? '');

  const itemCount = useItemCount({}, inventoryMetric === 'total');
  const lowStock = useLowStockCount({ enabled: inventoryMetric === 'lowStock' });
  const outOfStock = useOutOfStockCount({ enabled: inventoryMetric === 'outOfStock' });

  // "Active" is every status bar the terminal ones, asked of the database rather than applied to a
  // page of rows — see ACTIVE_PROJECT_STATUSES, which derives the set from PROJECT_STATUSES.
  const projectFilter: ProjectFilter = projectsMetric === 'all' ? {} : { statuses: ACTIVE_PROJECT_STATUSES };
  const projectCount = useProjectCount(projectFilter, {
    enabled: projectsMetric !== 'overBudget',
    // Switching the tile's metric changes the filter, so a held-over figure would be the other
    // metric's number under this one's label. The tile shows no pill until the new count lands.
    keepPrevious: false,
  });
  const budgetAlerts = useBudgetAlerts({ enabled: projectsMetric === 'overBudget' });

  const purchaseOrderCount = usePurchaseOrderCount(purchaseOrdersMetric === 'all' ? {} : { open: true });
  const contactCount = useContactCount();
  const bookingCount = useBookingCount(BOOKING_SCOPE_BY_METRIC[bookingsMetric] ?? 'upcoming');

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

  // Projects — the filtered project count (active / all), or the over-budget count from the
  // budget feed, which is already every budgeted project rather than a page of them.
  if (projectsMetric === 'overBudget') {
    if (budgetAlerts.data) {
      counts['/projects'] = navCountFor(
        '/projects',
        projectsMetric,
        countOverBudgetProjects(budgetAlerts.data, budgetWarnPercent),
      );
    }
  } else if (typeof projectCount.data === 'number') {
    counts['/projects'] = navCountFor('/projects', projectsMetric, projectCount.data);
  }

  if (typeof purchaseOrderCount.data === 'number') {
    counts['/purchase-orders'] = navCountFor(
      '/purchase-orders',
      purchaseOrdersMetric,
      purchaseOrderCount.data,
    );
  }

  if (typeof contactCount.data === 'number') {
    counts['/contacts'] = {
      count: contactCount.data,
      noun: 'contact',
      nounPlural: 'contacts',
      tone: 'neutral',
    };
  }

  if (typeof bookingCount.data === 'number') {
    counts['/bookings'] = navCountFor('/bookings', bookingsMetric, bookingCount.data);
  }

  return counts;
}
