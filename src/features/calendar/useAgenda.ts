/**
 * useAgenda — data hook for the unified "Upcoming" agenda (Phase 75).
 *
 * Fetches the seven date-driven feeds through existing repository methods and runs the pure
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
import { agendaKeys } from './keys';
import { nowMs } from '@/lib/clock';
import { readAllPages } from '@/lib/read-all-pages';
import { useFormatters } from '@/lib/useFormatters';

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
 * Combine the seven agenda source feeds into a single sorted `AgendaEvent[]`.
 *
 * @returns
 *   - `events`    — every pending event, soonest first.
 *   - `now`       — the single wall-clock instant the events were anchored at; the screen
 *                   MUST bucket against this same value so date-less events (anchored at
 *                   `now`) land in "Today" rather than being pushed into "Overdue" by a
 *                   marginally-later second clock read.
 *   - `isLoading` — true while any source query is still loading.
 *   - `isError`   — true when any source query errored.
 *   - `fieldDueTruncated` — true when the custom-field due-date read hit its ceiling, so that
 *     lane is a prefix rather than the whole set. Surfaced rather than swallowed (#606/#607).
 */
export function useAgenda(): {
  readonly events: AgendaEvent[];
  readonly now: number;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly fieldDueTruncated: boolean;
} {
  const now = nowMs();
  // Format every date in the agenda copy through the shared formatter seam so a due/expiry/booking
  // date reads in the user's locale, exactly as the same field does elsewhere (issue #328).
  const { date: formatDate } = useFormatters();

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
  const customFieldsOn = enabled.has('custom-fields');

  const maintenanceQuery = useQuery({
    queryKey: agendaKeys.maintenance(),
    queryFn: () => getMaintenanceRepository().listUpcoming(now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: maintenanceOn,
  });

  const warrantyQuery = useQuery({
    queryKey: agendaKeys.warranty(AGENDA_LOOKAHEAD_DAYS),
    queryFn: () =>
      getItemRepository().listWarrantyExpiring(AGENDA_LOOKAHEAD_DAYS, now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: warrantyOn,
  });

  const expiryQuery = useQuery({
    queryKey: agendaKeys.expiry(AGENDA_LOOKAHEAD_DAYS),
    queryFn: () =>
      getItemRepository().listExpiringWithin(AGENDA_LOOKAHEAD_DAYS, now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: perishablesOn,
  });

  const checkoutsQuery = useQuery({
    queryKey: agendaKeys.checkouts(),
    queryFn: () => getCheckoutRepository().listOpen({ limit: AGENDA_FETCH_LIMIT }),
    enabled: contactsOn,
  });

  const reorderQuery = useQuery({
    queryKey: agendaKeys.reorder(),
    queryFn: () => getReportRepository().listReorderShortfall(),
  });

  const bookingsQuery = useQuery({
    queryKey: agendaKeys.bookings(),
    queryFn: () => getAssetBookingRepository().listUpcoming(now, { limit: AGENDA_FETCH_LIMIT }),
    enabled: bookingsOn,
  });

  /**
   * Opted-in custom-field due dates (W1a). Asked for under the shared lookahead rather than
   * each definition's own lead time — the agenda is the forward calendar, so a date belongs on
   * it from the moment it is recorded; the lead time only decides when it becomes an *alert*.
   *
   * Walks every page rather than reading one and calling it the feed. The other six lanes cap
   * at a single page and say nothing about it; here the truncation is reported and shown
   * (issues #606/#607).
   */
  const fieldDueQuery = useQuery({
    queryKey: agendaKeys.fieldDue(AGENDA_LOOKAHEAD_DAYS),
    queryFn: () =>
      readAllPages((page) =>
        getItemRepository().listFieldDueDates(now, { ...page, withinDays: AGENDA_LOOKAHEAD_DAYS }),
      ),
    enabled: customFieldsOn,
  });

  const isLoading =
    maintenanceQuery.isLoading ||
    warrantyQuery.isLoading ||
    expiryQuery.isLoading ||
    checkoutsQuery.isLoading ||
    reorderQuery.isLoading ||
    bookingsQuery.isLoading ||
    fieldDueQuery.isLoading;

  const isError =
    maintenanceQuery.isError ||
    warrantyQuery.isError ||
    expiryQuery.isError ||
    checkoutsQuery.isError ||
    reorderQuery.isError ||
    bookingsQuery.isError ||
    fieldDueQuery.isError;

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

    fieldDue: customFieldsOn
      ? (fieldDueQuery.data?.rows ?? []).map((row) => ({
          itemId: row.itemId,
          itemName: row.itemName,
          defId: row.defId,
          fieldName: row.fieldName,
          dueAt: row.dueAt,
        }))
      : [],
  };

  const events = buildAgenda(sources, now, formatDate);

  // Only meaningful while the lane is on and loaded; a disabled lane is not "truncated".
  const fieldDueTruncated = customFieldsOn && (fieldDueQuery.data?.truncated ?? false);

  return { events, now, isLoading, isError, fieldDueTruncated };
}
