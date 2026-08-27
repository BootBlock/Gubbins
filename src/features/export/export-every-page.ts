/**
 * Export a **whole** list, not the page of it that happens to be on screen (issue #132).
 *
 * Every browse list in the app is read a bounded page at a time — the repositories clamp to
 * `MAX_PAGE_SIZE`, and with the "Paginate long lists" preference on the screen holds exactly one
 * page. Serialising those rows would produce a file that looks complete and is quietly short:
 * the same failure `readAllPages` was written for (issue #149), where a truncated BOM read fed
 * the BOM export.
 *
 * So an export re-reads its list from the repository, walking every page, rather than
 * serialising whatever the screen is holding. Where the set is genuinely unbounded (the activity
 * ledger), the walk stops at the {@link readAllPages} ceiling — and this attaches the caveat to
 * the result so the user is *told* the file stops short. Nothing is cut short in silence.
 */
import { readAllPages, type PagedChunk } from '@/lib/read-all-pages';
import { assertPermissions } from '@/features/users/assert-permission';
import { currentAuthority } from '@/features/users/current-authority';
import type { TabularExportResult } from './tabular-export';

/**
 * Read every page of `read`, serialise the lot with `build`, and attach `truncatedNotice` when
 * the walk hit its ceiling with rows still unread.
 *
 * Gated on `export:run` (issue #429), and gated **here** rather than at each screen's export
 * button. This is the seam where a bulk export actually happens — the moment a list stops being
 * the page on screen and becomes every row of it, bound for a file. Every list export in the app
 * funnels through it, so one check covers them all and none can be added later that forgets one;
 * a check on a button is a courtesy, not a boundary. The per-row reads it walks still assert
 * their own subject keys, so `export:run` is required *in addition to* being allowed to read the
 * list at all, never instead of it.
 *
 * @param read One page of the list — any repository method taking `{ limit, offset }`.
 * @param build Serialise the complete row set (a feature's pure `build*Export`, format bound).
 * @param truncatedNotice User-facing caveat for the incomplete case, surfaced on the toast.
 *   Passed in rather than written here because it is UI copy and belongs to the caller's
 *   translation catalog, while this seam stays free of React and i18n.
 */
export async function exportEveryPage<T>(
  read: (params: { limit: number; offset: number }) => Promise<PagedChunk<T>>,
  build: (rows: readonly T[]) => Promise<TabularExportResult>,
  truncatedNotice: string,
): Promise<TabularExportResult> {
  assertPermissions(currentAuthority(), ['export:run']);
  const { rows, truncated } = await readAllPages(read);
  const result = await build(rows);
  return truncated ? { ...result, notice: truncatedNotice } : result;
}

/**
 * A file-safe, date-stamped download name shared by the list exports, e.g.
 * `gubbins-activity-2026-07-25.csv`. One helper so every list export names its file the same
 * way — they land in one downloads folder together, and sort by list then date.
 */
export function listExportFilename(list: string, extension: string, date = new Date()): string {
  return `gubbins-${list}-${date.toISOString().slice(0, 10)}.${extension}`;
}

/**
 * An ISO-8601 UTC timestamp for a stored epoch-milliseconds column, or `null`.
 *
 * Export files carry timestamps in ISO form rather than the screen's localised rendering: the
 * file outlives the session that produced it and may be read in another timezone or by a
 * spreadsheet, where "12/07/26" is ambiguous and a raw epoch integer is unreadable. The screen
 * keeps its localised formatting; the file is locale-independent, exactly as the money and
 * quantity columns are.
 *
 * A value that is not a usable instant blanks its own cell rather than throwing: `toISOString`
 * raises on any input `Date` cannot represent — a `NaN`, and equally a perfectly finite number
 * past the ±8.64e15 ms range — and one unreadable stored timestamp must not cost the user the
 * whole export file, the same reasoning the catalogue CSV's `expiryDate` cell uses. Testing the
 * constructed `Date` rather than the number catches both in one check.
 */
export function isoTimestamp(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The calendar day of a **day-grained** stored value (`YYYY-MM-DD`), or `null`.
 *
 * Booking start/end dates are midnight-UTC day-starts (issue #320), so the UTC date component
 * *is* the booked day in every timezone. Rendering one as a local timestamp would slip it a day
 * west of UTC — the same trap `calendarDate` exists to avoid on screen.
 */
export function isoCalendarDay(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}
