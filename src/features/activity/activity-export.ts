/**
 * Activity-feed export (issue #132): serialise the global activity ledger to a downloadable
 * file — the record of what happened to the inventory and when, for an audit trail, a handover,
 * or a spreadsheet someone wants to pivot.
 *
 * Pure: it maps {@link ActivityFeedEntry} rows onto the shared tabular column model and hands
 * them to the generic serialisers in `@/features/export/tabular-export`, so every format comes
 * from one column definition. Kept free of React and repositories — the screen supplies the rows
 * (read whole via `exportEveryPage`, since the feed is paged on screen).
 */
import {
  buildTabularExport,
  type TabularCell,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoTimestamp, listExportFilename } from '@/features/export/export-every-page';
import { describeHistoryEntry, historyActionLabel } from '@/features/inventory/history-format';
import type { ActivityFeedEntry } from '@/db/repositories';
import { ACTIVITY_KIND_LABEL, activityKindForAction } from './activity-kind';

/**
 * The export columns — the feed row's own content, plus the kind the filter chips group by
 * (which on screen is a filter rather than a column, and is what makes the file sortable).
 *
 * The two deltas are split into **separate raw-number columns** rather than reproducing the
 * screen's single signed badge: that badge renders a true minus sign (`−`, U+2212) for a loss,
 * which a spreadsheet reads as text rather than a negative number. A file is for arithmetic, so
 * it carries the stored figures unchanged and lets the reader's tool format them.
 *
 * @internal Exported for unit tests only.
 */
export function activityExportColumns(): readonly TabularColumn<ActivityFeedEntry>[] {
  return [
    { header: 'When', value: (e) => isoTimestamp(e.createdAt) },
    { header: 'Item', value: (e) => e.itemName },
    { header: 'Kind', value: (e) => ACTIVITY_KIND_LABEL[activityKindForAction(e.action)] },
    { header: 'Action', value: (e) => historyActionLabel(e.action) },
    { header: 'Detail', value: (e): TabularCell => describeHistoryEntry(e).detail },
    { header: 'Quantity change', value: (e): TabularCell => e.quantityDelta },
    { header: 'Value change', value: (e): TabularCell => e.netValueDelta },
  ];
}

/** Serialise the activity feed to the chosen format via the shared exporter. */
export function buildActivityExport(
  format: TabularExportFormat,
  entries: readonly ActivityFeedEntry[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, activityExportColumns(), entries, {
    title: 'Activity',
    caption: `${entries.length} event${entries.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the activity feed, e.g. `gubbins-activity-2026-07-25.csv`. */
export function activityExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('activity', extension, date);
}
