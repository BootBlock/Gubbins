/**
 * useAgenda — data hook for the unified "Upcoming" agenda (Phase 75).
 *
 * Fetches the five date-driven feeds through existing repository methods and runs the pure
 * {@link buildAgenda} seam to produce a sorted `AgendaEvent[]`. Read-only: no new SQL beyond
 * the additive `MaintenanceRepository.listUpcoming` (which lists *future* schedules, not just
 * the overdue ones {@link useAlerts} needs). Maintenance due-ness is derived here with the
 * lifecycle maths (`maintenanceDueAtMs` for TIME, `maintenanceStatus` for USAGE) so the pure
 * agenda seam never reaches into the repository layer.
 */
import { useQuery } from '@tanstack/react-query';
import {
  getAssetBookingRepository,
  getCheckoutRepository,
  getItemRepository,
  getMaintenanceRepository,
  getReportRepository,
} from '@/db/repositories';
import { maintenanceStatus } from '@/features/lifecycle/maintenance';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { buildAgenda, maintenanceDueAtMs, type AgendaEvent, type AgendaSources } from './agenda';

/**
 * Lookahead window (days) for the warranty/expiry feeds — ~100 years, i.e. effectively
 * unbounded in date terms, so the "Later" bucket is a true catch-all rather than a window.
 */
const AGENDA_LOOKAHEAD_DAYS = 36_500;

/**
 * Upper bound on rows pulled per feed — generous, since the agenda shows everything pending.
 * The feeds order soonest-first, so in the extreme case of >500 pending date-driven events
 * the cap drops only the most distant tail (deep inside "Later"); the nearer buckets that
 * drive action stay complete.
 */
const AGENDA_FETCH_LIMIT = 500;

/**
 * Combine the five agenda source feeds into a single sorted `AgendaEvent[]`.
 *
 * @returns
 *   - `events`    — every pending event, soonest first.
 *   - `now`       — the single wall-clock instant the events were anchored at; the screen
 *                   MUST bucket against this same value so date-less events (anchored at
 *                   `now`) land in "Today" rather than being pushed into "Overdue" by a
 *                   marginally-later second clock read.
 *   - `isLoading` — true while any source query is still loading.
 *   - `isError`   — true when any source query errored.
 */
export function useAgenda(): {
  readonly events: AgendaEvent[];
  readonly now: number;
  readonly isLoading: boolean;
  readonly isError: boolean;
} {
  const now = Date.now();

  // Modular UI (Phase 7): each date-driven lane gates on its owning feature. A disabled lane
  // skips its source fetch (`enabled: false`) AND feeds an empty array into the pure
  // `buildAgenda` seam below, so it produces no events even if a stale cache entry still holds
  // rows. Reorder is core inventory and never gated. The feature set is read once,
  // unconditionally (rules of hooks).
  const enabled = useEnabledFeatures();
  const maintenanceOn = enabled.has('maintenance');
  const warrantyOn = enabled.has('warranty');
  const perishablesOn = enabled.has('perishables');
  const contactsOn = enabled.has('contacts');
  const bookingsOn = enabled.has('bookings');

  const maintenanceQuery = useQuery({
    queryKey: ['agenda', 'maintenance'],
    queryFn: () => getMaintenanceRepository().listUpcoming(now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: maintenanceOn,
  });

  const warrantyQuery = useQuery({
    queryKey: ['agenda', 'warranty', AGENDA_LOOKAHEAD_DAYS],
    queryFn: () =>
      getItemRepository().listWarrantyExpiring(AGENDA_LOOKAHEAD_DAYS, now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: warrantyOn,
  });

  const expiryQuery = useQuery({
    queryKey: ['agenda', 'expiry', AGENDA_LOOKAHEAD_DAYS],
    queryFn: () =>
      getItemRepository().listExpiringWithin(AGENDA_LOOKAHEAD_DAYS, now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: perishablesOn,
  });

  const checkoutsQuery = useQuery({
    queryKey: ['agenda', 'checkouts'],
    queryFn: () => getCheckoutRepository().listOpen({ limit: AGENDA_FETCH_LIMIT }),
    enabled: contactsOn,
  });

  const reorderQuery = useQuery({
    queryKey: ['agenda', 'reorder'],
    queryFn: () => getReportRepository().listReorderShortfall(),
  });

  const bookingsQuery = useQuery({
    queryKey: ['agenda', 'bookings'],
    queryFn: () => getAssetBookingRepository().listUpcoming(now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: bookingsOn,
  });

  const isLoading =
    maintenanceQuery.isLoading ||
    warrantyQuery.isLoading ||
    expiryQuery.isLoading ||
    checkoutsQuery.isLoading ||
    reorderQuery.isLoading ||
    bookingsQuery.isLoading;

  const isError =
    maintenanceQuery.isError ||
    warrantyQuery.isError ||
    expiryQuery.isError ||
    checkoutsQuery.isError ||
    reorderQuery.isError ||
    bookingsQuery.isError;

  const sources: AgendaSources = {
    maintenance: maintenanceOn
      ? (maintenanceQuery.data?.rows ?? []).map((s) => ({
          scheduleId: s.id,
          itemId: s.itemId,
          itemName: s.itemName,
          scheduleName: s.name,
          // TIME schedules carry a calendar due instant; USAGE schedules return null and are
          // surfaced only while actually due (no calendar position).
          dueAtMs: maintenanceDueAtMs(s.basis, s.lastPerformedAt, s.createdAt, s.intervalDays),
          usageDue:
            s.basis === 'USAGE'
              ? maintenanceStatus(
                  {
                    basis: s.basis,
                    intervalDays: s.intervalDays,
                    intervalUsage: s.intervalUsage,
                    usageSinceService: s.usageSinceService,
                    accrueCheckoutHours: s.accrueCheckoutHours,
                    autoUsage: s.autoUsageHours,
                    lastPerformedAt: s.lastPerformedAt,
                    createdAt: s.createdAt,
                  },
                  now,
                ).due
              : false,
        }))
      : [],

    warranty: warrantyOn
      ? (warrantyQuery.data?.rows ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          warrantyExpiresAt: item.warrantyExpiresAt,
        }))
      : [],

    expiry: perishablesOn
      ? (expiryQuery.data?.rows ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          expiryDate: item.expiryDate ?? null,
        }))
      : [],

    checkouts: contactsOn
      ? (checkoutsQuery.data?.rows ?? []).map((k) => ({
          id: k.id,
          itemId: k.itemId,
          itemName: k.itemName,
          borrowerName: k.borrowerName,
          dueDate: k.dueDate,
        }))
      : [],

    reorder: (reorderQuery.data ?? []).map((r) => ({
      itemId: r.itemId,
      itemName: r.itemName,
      shortfall: r.shortfall,
    })),

    bookings: bookingsOn
      ? (bookingsQuery.data?.rows ?? []).map((b) => ({
          id: b.id,
          itemId: b.itemId,
          itemName: b.itemName,
          contactName: b.contactName,
          startDate: b.startDate,
          endDate: b.endDate,
        }))
      : [],
  };

  const events = buildAgenda(sources, now);

  return { events, now, isLoading, isError };
}
