/**
 * Location activity-feed export (issue #693): serialise the cross-location activity record to a
 * downloadable file — the answer to *"what happened to the top shelf?"* for a place that may no
 * longer exist to be opened.
 *
 * The sibling of `activity-export.ts`, and deliberately its own column set rather than a reuse:
 * the item columns are item-shaped (an owning item name, a quantity delta, a value delta), and a
 * location entry has none of those. What it has is a place, an action and the words describing it,
 * so the file is **when / location / action / detail** and nothing else — four honest columns
 * beats seven with three permanently blank.
 *
 * Pure: it maps {@link LocationHistoryEntry} rows onto the shared tabular column model and hands
 * them to the generic serialisers in `@/features/export/tabular-export`. Kept free of React and
 * repositories — the screen supplies the rows, read whole via `exportEveryPage`.
 */
import {
  buildTabularExport,
  type TabularCell,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoTimestamp, listExportFilename } from '@/features/export/export-every-page';
import { describeLocationHistoryEntry } from '@/features/inventory/location-history-format';
import type { LocationHistoryEntry } from '@/db/repositories';
import { eventCaption } from './activity-export';

/**
 * The lane's columns.
 *
 * The action and the detail both come from the same pure `describeLocationHistoryEntry` seam the
 * screen renders through, so a file and the rows it was exported from can never disagree about
 * what a `RE_PARENTED` entry is called.
 *
 * `locationName` is the name the place carried **when the entry was written**, not a lookup of
 * what it is called now — which is the whole point for a location that has since been renamed or
 * deleted. There is deliberately no id column: the stored `location_id` is a historical
 * coordinate, meaningless outside this database, and a reader has the name.
 *
 * @internal Exported for unit tests only.
 */
export function locationActivityExportColumns(): readonly TabularColumn<LocationHistoryEntry>[] {
  return [
    { header: 'When', value: (e) => isoTimestamp(e.createdAt) },
    { header: 'Location', value: (e) => e.locationName },
    { header: 'Action', value: (e) => describeLocationHistoryEntry(e).label },
    { header: 'Detail', value: (e): TabularCell => describeLocationHistoryEntry(e).detail },
  ];
}

/** Serialise the location activity feed to the chosen format via the shared exporter. */
export function buildLocationActivityExport(
  format: TabularExportFormat,
  entries: readonly LocationHistoryEntry[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, locationActivityExportColumns(), entries, {
    title: 'Location activity',
    caption: eventCaption(entries.length),
  });
}

/**
 * Download file name for the location activity feed, e.g.
 * `gubbins-location-activity-2026-07-31.csv` — the shared list-export naming, so it sorts beside
 * `gubbins-activity-*` in a downloads folder.
 */
export function locationActivityExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('location-activity', extension, date);
}
