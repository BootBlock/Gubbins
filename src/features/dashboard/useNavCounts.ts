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
 * The Projects / Purchase-orders / Bookings tiles are **configurable** (backlog A1): the
 * user can re-point them at a different metric (e.g. *all projects*, *bookings starting this
 * week*) from Settings → Dashboard. The choice is a Tier-2 preference (`navCountMetrics`); the
 * available metrics, their labels and their spoken nouns are the `NAV_COUNT_METRIC_CONFIG`
 * SSOT, and each metric is a **pure selector** over the same rows the tile's read hook already
 * loads — so switching metric costs no extra fetch. Inventory and Contacts have a single
 * meaningful metric, so they are not configurable.
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
import { useProjects } from '@/features/projects/projects';
import { usePurchaseOrders } from '@/features/purchasing/queries';
import { navCountOption, normaliseNavCountMetric, type NavCountRoute } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { AppRoutePath } from '@/components/nav/nav-destinations';

/** One counted tile's badge: the figure plus the spoken nouns for its accessible name. */
export interface NavCount {
  readonly count: number;
  /** Singular spoken noun ("active project"), pluralised with the count at the call site. */
  readonly noun: string;
  /** Plural spoken noun ("active projects") — the irregular form for phrase nouns. */
  readonly nounPlural: string;
}

/** Milliseconds in a day — the width of the "starting this week" booking window. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant at the start of the local day — the cut-off for a booking still being upcoming. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Spoken nouns for the single-metric (non-configurable) tiles. */
const FIXED_NOUNS: Partial<Record<AppRoutePath, Omit<NavCount, 'count'>>> = {
  '/inventory': { noun: 'item', nounPlural: 'items' },
  '/contacts': { noun: 'contact', nounPlural: 'contacts' },
};

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

/** Purchase orders: all orders, or only the *open* ones (default — not RECEIVED / CANCELLED). */
export function countPurchaseOrders(rows: readonly PurchaseOrderRow[], metric: string): number {
  if (metric === 'all') return rows.length;
  return rows.filter((po) => po.effectiveStatus !== 'RECEIVED' && po.effectiveStatus !== 'CANCELLED').length;
}

/**
 * Bookings: every booking, only those *starting this week* (the next 7 days), or the
 * *upcoming* ones (default). A live booking is one neither cancelled nor converted to a loan;
 * dates are day-start UNIX-ms, so "upcoming" compares the last day against the start of today
 * (an all-day booking is still upcoming on its final day) and "this week" is a rolling 7-day
 * window from the start of today.
 */
export function countBookings(rows: readonly BookingRow[], metric: string): number {
  if (metric === 'all') return rows.length;
  const live = rows.filter((b) => !b.cancelledAt && !b.convertedCheckoutId);
  if (metric === 'thisWeek') {
    const start = startOfToday();
    const end = start + 7 * DAY_MS;
    return live.filter((b) => b.startDate >= start && b.startDate < end).length;
  }
  const cutoff = startOfToday();
  return live.filter((b) => b.endDate >= cutoff).length;
}

/** Resolve a configurable tile's current metric and build its {@link NavCount}. */
function configurable(
  route: NavCountRoute,
  metrics: Record<NavCountRoute, string>,
  count: (metric: string) => number,
): NavCount {
  const metric = normaliseNavCountMetric(route, metrics[route] ?? '');
  const opt = navCountOption(route, metric);
  return { count: count(metric), noun: opt.noun, nounPlural: opt.nounPlural };
}

/**
 * The badge per counted destination, keyed by route. A key is present only once its source
 * query has resolved; absent while loading. Counts may be `0` — the caller decides whether a
 * `0` is worth a badge (it isn't).
 */
export function useNavCounts(): Partial<Record<AppRoutePath, NavCount>> {
  const itemCount = useItemCount();
  const projects = useProjects();
  const purchaseOrders = usePurchaseOrders();
  const contacts = useContacts();
  const bookings = useBookings();
  const metrics = usePreferencesStore((s) => s.navCountMetrics);

  const counts: Partial<Record<AppRoutePath, NavCount>> = {};

  if (typeof itemCount.data === 'number') {
    counts['/inventory'] = { count: itemCount.data, ...FIXED_NOUNS['/inventory']! };
  }

  if (projects.data) {
    counts['/projects'] = configurable('/projects', metrics, (m) => countProjects(projects.data.rows, m));
  }

  if (purchaseOrders.data) {
    counts['/purchase-orders'] = configurable('/purchase-orders', metrics, (m) =>
      countPurchaseOrders(purchaseOrders.data.rows, m),
    );
  }

  if (contacts.data) {
    counts['/contacts'] = { count: contacts.data.rows.length, ...FIXED_NOUNS['/contacts']! };
  }

  if (bookings.data) {
    counts['/bookings'] = configurable('/bookings', metrics, (m) => countBookings(bookings.data.rows, m));
  }

  return counts;
}
