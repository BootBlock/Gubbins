/**
 * Bookings export (issue #132): serialise the asset-booking calendar to a downloadable file —
 * a reservation schedule to circulate, or to reconcile against a diary.
 *
 * Pure — it maps {@link AssetBookingWithNames} rows onto the shared tabular column model and
 * hands them to the generic serialisers in `@/features/export/tabular-export`. Kept free of
 * React and repositories; `now` is injected rather than read from a clock, so the derived
 * status column is deterministic and unit-testable.
 */
import type { AssetBookingWithNames } from '@/db/repositories';
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoCalendarDay, isoTimestamp, listExportFilename } from '@/features/export/export-every-page';
import { BOOKING_STATUS_LABEL, deriveBookingStatus } from './booking-status';

/**
 * The export columns — what a booking card shows.
 *
 * `From` / `To` are **calendar days** (`YYYY-MM-DD`), not timestamps: a booking's start and end
 * are midnight-UTC day-starts (issue #320), so the UTC date component is the booked day in
 * every timezone. Rendering them as local timestamps would slip a booking a day west of UTC —
 * the trap `calendarDate` avoids on screen. `Cancelled` is a real timestamp, because it records
 * a moment rather than a booked day.
 *
 * Status is derived against the injected `now`, exactly as the screen derives it per render, so
 * the file's statuses agree with the headings the user was looking at when they exported.
 *
 * @internal Exported for unit tests only.
 */
export function bookingsExportColumns(now: number): readonly TabularColumn<AssetBookingWithNames>[] {
  return [
    { header: 'Asset', value: (b) => b.itemName },
    { header: 'Contact', value: (b) => b.contactName },
    { header: 'From', value: (b) => isoCalendarDay(b.startDate) },
    { header: 'To', value: (b) => isoCalendarDay(b.endDate) },
    { header: 'Status', value: (b) => BOOKING_STATUS_LABEL[deriveBookingStatus(b, now)] },
    { header: 'Cancelled', value: (b) => isoTimestamp(b.cancelledAt) },
    { header: 'Note', value: (b) => b.note },
  ];
}

/** Serialise the bookings list to the chosen format via the shared exporter. */
export function buildBookingsExport(
  format: TabularExportFormat,
  bookings: readonly AssetBookingWithNames[],
  now: number,
): Promise<TabularExportResult> {
  return buildTabularExport(format, bookingsExportColumns(now), bookings, {
    title: 'Bookings',
    caption: `${bookings.length} booking${bookings.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the bookings list, e.g. `gubbins-bookings-2026-07-25.csv`. */
export function bookingsExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('bookings', extension, date);
}
