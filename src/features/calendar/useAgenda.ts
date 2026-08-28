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
import { effectiveExpiryDate } from '@/features/lifecycle/expiry';
import { maintenanceStatus } from '@/features/lifecycle/maintenance';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermissionCheck } from '@/features/users/usePermission';
import {
  buildAgenda,
  maintenanceDueAtMs,
  type AgendaEvent,
  type AgendaKind,
  type AgendaSources,
} from './agenda';
import { agendaKeys } from './keys';
import { addCalendarDays } from '@/lib/calendar-days';
import { nowMs } from '@/lib/clock';
import { readAllPages } from '@/lib/read-all-pages';
import { useFormatters } from '@/lib/useFormatters';

/**
 * Lookahead window (days) for the warranty/expiry feeds — ~100 years, i.e. effectively
 * unbounded in date terms, so the "Later" bucket is a true catch-all rather than a window.
 */
const AGENDA_LOOKAHEAD_DAYS = 36_500;

/**
 * Look-**back** window (days) for the warranty/expiry feeds — one year (issue #607).
 *
 * Those two feeds select every dated row at or before the cutoff and order it ascending. With a
 * century-wide cutoff and no lower bound, "everything ever dated, oldest first" is the query,
 * which is the wrong question for a screen whose subject is what happens next: an inventory of
 * any age fills its Overdue bucket with dates from a decade ago, and before the feeds walked
 * their pages that history was all a lane returned.
 *
 * The other lanes need no such bound. Maintenance stays due until performed, an open loan stays
 * open, the booking feed is already cut at today, and a reorder shortfall carries no date at all
 * — none of them accumulates a tail of settled history the way a lapsed warranty does.
 *
 * A year is deliberately generous: long enough that an annual review still finds what lapsed,
 * short enough that the set stays agenda-sized. `CalendarScreen` names the bound on screen
 * whenever an Overdue section is showing, so nothing is dropped in silence.
 */
const AGENDA_LOOKBACK_DAYS = 365;

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
 *   - `truncatedKinds` — the lanes whose read hit the {@link readAllPages} ceiling, so the lane
 *     is a prefix rather than the whole set. Surfaced rather than swallowed (#606/#607).
 *   - `lookbackDays` — how far back the two dated item lanes reach, for the on-screen note.
 */
export function useAgenda(): {
  readonly events: AgendaEvent[];
  readonly now: number;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly truncatedKinds: ReadonlySet<AgendaKind>;
  readonly lookbackDays: number;
} {
  const now = nowMs();
  // Oldest date the two dated item feeds reach back to (issue #607). Derived from the same `now`
  // the events are anchored at, so the window and the buckets agree.
  const lookbackSince = addCalendarDays(now, -AGENDA_LOOKBACK_DAYS);
  // Format every date in the agenda copy through the shared formatter seam so a due/expiry/booking
  // date reads in the user's locale, exactly as the same field does elsewhere (issue #328).
  const { date: formatDate } = useFormatters();

  // Modular UI (Phase 7): each date-driven lane gates on its owning feature. A disabled lane
  // skips its source fetch (`enabled: false`) AND feeds an empty array into the pure
  // `buildAgenda` seam below, so it produces no events even if a stale cache entry still holds
  // rows. The feature set is read once, unconditionally (rules of hooks).
  //
  // Each lane is *also* gated on the read permission of whatever it draws from (issue #522).
  // Upcoming is one of two screens that aggregate several subjects rather than showing one, so
  // it carries no read gate of its own — the gate has to be per lane, or a role that cannot open
  // Bookings would still read them here. Folding the permission into the same boolean keeps the
  // fetch and the source array in step.
  const enabled = useEnabledFeatures();
  const allows = usePermissionCheck();
  const itemsReadable = allows('items:read');
  const maintenanceOn = enabled.has('maintenance') && allows('maintenance:read');
  const warrantyOn = enabled.has('warranty') && itemsReadable;
  const perishablesOn = enabled.has('perishables') && itemsReadable;
  const contactsOn = enabled.has('contacts') && allows('checkouts:read');
  const bookingsOn = enabled.has('bookings') && allows('bookings:read');
  const customFieldsOn = enabled.has('custom-fields') && itemsReadable;
  // Reorder shortfalls are item stock, so they follow the items gate rather than a module one.
  const reorderOn = itemsReadable;

  // Every paginated lane walks its pages (issue #607). A repository read clamps `limit` to
  // MAX_PAGE_SIZE (100), so a lane that asked for one "generous" page of 500 got a hundred rows
  // and said nothing about the rest — and because these feeds order by date ascending, the
  // hundred it kept were the oldest, not the soonest. `readAllPages` reads the whole set
  // instead, and reports it when its own ceiling stops the walk.

  const maintenanceQuery = useQuery({
    queryKey: agendaKeys.maintenance(),
    queryFn: () => readAllPages((page) => getMaintenanceRepository().listUpcoming(now, page)),
    enabled: maintenanceOn,
  });

  const warrantyQuery = useQuery({
    queryKey: agendaKeys.warranty(AGENDA_LOOKAHEAD_DAYS, AGENDA_LOOKBACK_DAYS),
    queryFn: () =>
      readAllPages((page) =>
        getItemRepository().listWarrantyExpiring(AGENDA_LOOKAHEAD_DAYS, now, {
          ...page,
          since: lookbackSince,
        }),
      ),
    enabled: warrantyOn,
  });

  const expiryQuery = useQuery({
    queryKey: agendaKeys.expiry(AGENDA_LOOKAHEAD_DAYS, AGENDA_LOOKBACK_DAYS),
    queryFn: () =>
      readAllPages((page) =>
        getItemRepository().listExpiringWithin(AGENDA_LOOKAHEAD_DAYS, now, {
          ...page,
          since: lookbackSince,
        }),
      ),
    enabled: perishablesOn,
  });

  const checkoutsQuery = useQuery({
    queryKey: agendaKeys.checkouts(),
    queryFn: () => readAllPages((page) => getCheckoutRepository().listOpen(page)),
    enabled: contactsOn,
  });

  const reorderQuery = useQuery({
    queryKey: agendaKeys.reorder(),
    queryFn: () => getReportRepository().listReorderShortfall(),
    enabled: reorderOn,
  });

  const bookingsQuery = useQuery({
    queryKey: agendaKeys.bookings(),
    queryFn: () => readAllPages((page) => getAssetBookingRepository().listUpcoming(now, page)),
    enabled: bookingsOn,
  });

  /**
   * Opted-in custom-field due dates (W1a). Asked for under the shared lookahead rather than
   * each definition's own lead time — the agenda is the forward calendar, so a date belongs on
   * it from the moment it is recorded; the lead time only decides when it becomes an *alert*.
   *
   * Walks every page, as every other paginated lane now does (issues #606/#607).
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
          effectiveExpiryDate: effectiveExpiryDate(item.expiryDate, item.earliestBatchExpiryDate),
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

    reorder: reorderOn
      ? (reorderQuery.data ?? []).map((r) => ({
          itemId: r.itemId,
          itemName: r.itemName,
          shortfall: r.shortfall,
        }))
      : [],

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

  // Only meaningful while the lane is on and loaded; a disabled lane is not "truncated" (a
  // stale cache entry from when it was on must not speak for it). The reorder lane is absent
  // because its read is unpaginated — it has no ceiling to hit.
  const truncatedKinds = new Set<AgendaKind>();
  const noteTruncated = (kind: AgendaKind, on: boolean, truncated: boolean | undefined) => {
    if (on && truncated === true) truncatedKinds.add(kind);
  };
  noteTruncated('maintenance', maintenanceOn, maintenanceQuery.data?.truncated);
  noteTruncated('warranty', warrantyOn, warrantyQuery.data?.truncated);
  noteTruncated('expiry', perishablesOn, expiryQuery.data?.truncated);
  noteTruncated('checkout-due', contactsOn, checkoutsQuery.data?.truncated);
  noteTruncated('booking', bookingsOn, bookingsQuery.data?.truncated);
  noteTruncated('field-due', customFieldsOn, fieldDueQuery.data?.truncated);

  return { events, now, isLoading, isError, truncatedKinds, lookbackDays: AGENDA_LOOKBACK_DAYS };
}
