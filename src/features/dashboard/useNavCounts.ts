/**
 * useNavCounts — the "how many are in there" badge counts for the dashboard nav tiles.
 *
 * Each counted destination shows a small right-aligned count on its {@link DashboardNav}
 * card ("Projects → 3"), so the hub doubles as an at-a-glance summary. Only the
 * *collection* screens carry a count — the ones that are naturally "N of a thing" — and
 * each uses its domain's own idea of what's worth counting rather than a raw row total:
 *
 * | Destination      | Counts                                                            |
 * | ---------------- | ----------------------------------------------------------------- |
 * | Inventory        | every item in the catalogue                                       |
 * | Projects         | *active* projects (not COMPLETED / ARCHIVED)                      |
 * | Purchase orders  | *open* orders (DRAFT / ORDERED / PARTIAL — not RECEIVED/CANCELLED) |
 * | Contacts         | every contact                                                     |
 * | Bookings         | *upcoming* bookings (not cancelled/converted, not yet ended)      |
 *
 * Feeds (Upcoming / Activity) and the settings-y System tiles carry no count; Alerts keeps
 * its own dedicated attention badge in {@link DashboardNav}. A destination is omitted from
 * the returned map until its query has data, so a card never flashes a stale/`0` while its
 * count is still loading — and a genuine `0` is dropped by the caller (nothing to show).
 *
 * The reads reuse the existing per-domain hooks (same query keys → shared cache, no extra
 * fetch when a widget already loaded them), and the "what counts as active/open" filters
 * live here so {@link DashboardNav} stays pure presentation.
 */
import { useBookings } from '@/features/bookings/bookings';
import { useContacts } from '@/features/contacts/contacts';
import { useItemCount } from '@/features/inventory/queries';
import { useProjects } from '@/features/projects/projects';
import { usePurchaseOrders } from '@/features/purchasing/queries';
import type { AppRoutePath } from '@/components/nav/nav-destinations';

/** The instant at the start of the local day — the cut-off for a booking still being upcoming. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The badge count per counted destination, keyed by route. A key is present only once its
 * source query has resolved; absent while loading. Values may be `0` — the caller decides
 * whether a `0` is worth a badge (it isn't).
 */
export function useNavCounts(): Partial<Record<AppRoutePath, number>> {
  const itemCount = useItemCount();
  const projects = useProjects();
  const purchaseOrders = usePurchaseOrders();
  const contacts = useContacts();
  const bookings = useBookings();

  const counts: Partial<Record<AppRoutePath, number>> = {};

  if (typeof itemCount.data === 'number') {
    counts['/inventory'] = itemCount.data;
  }

  if (projects.data) {
    // "Active" = still in flight: anything that isn't finished (COMPLETED) or shelved (ARCHIVED).
    // These list hooks are the same paged reads the screens use (bounded sets fetched whole at
    // `limit: 100`), so the badge matches exactly what the destination shows.
    counts['/projects'] = projects.data.rows.filter(
      (p) => p.status !== 'COMPLETED' && p.status !== 'ARCHIVED',
    ).length;
  }

  if (purchaseOrders.data) {
    // "Open" = not yet settled: excludes the terminal RECEIVED / CANCELLED effective states.
    counts['/purchase-orders'] = purchaseOrders.data.rows.filter(
      (po) => po.effectiveStatus !== 'RECEIVED' && po.effectiveStatus !== 'CANCELLED',
    ).length;
  }

  if (contacts.data) {
    counts['/contacts'] = contacts.data.rows.length;
  }

  if (bookings.data) {
    // "Upcoming" = still to come or in progress: not cancelled, not converted to a loan, and
    // its last day hasn't passed (endDate is snapped to that day's start, so compare against
    // the start of today rather than `now`).
    const cutoff = startOfToday();
    counts['/bookings'] = bookings.data.rows.filter(
      (b) => !b.cancelledAt && !b.convertedCheckoutId && b.endDate >= cutoff,
    ).length;
  }

  return counts;
}

/**
 * Screen-reader noun for each counted destination, used to turn a bare number into a spoken
 * phrase on the tile ("Projects — 3 active projects"). Singular form; pluralised with
 * `plural()` at the call site. Keys mirror {@link useNavCounts}.
 */
export const NAV_COUNT_NOUNS: Partial<Record<AppRoutePath, string>> = {
  '/inventory': 'item',
  '/projects': 'active project',
  '/purchase-orders': 'open order',
  '/contacts': 'contact',
  '/bookings': 'upcoming booking',
};
