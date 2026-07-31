/**
 * Activity-feed export (issue #132): serialise the global activity ledger to a downloadable
 * file — the record of what happened to the inventory and when, for an audit trail, a handover,
 * or a spreadsheet someone wants to pivot.
 *
 * Pure: it maps {@link ActivityFeedEntry} rows onto the shared tabular column model and hands
 * them to the generic serialisers in `@/features/export/tabular-export`, so every format comes
 * from one column definition. Kept free of React and repositories — the screen supplies the rows
 * (read whole via `exportEveryPage`, since the feed is paged on screen).
 *
 * One item's own Activity Log exports from here too (issue #620), through the same column
 * definitions minus the item-name column every row of it would repeat.
 */
import {
  buildTabularExport,
  type TabularCell,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoTimestamp, listExportFilename } from '@/features/export/export-every-page';
import { plural } from '@/lib/plural';
import { describeHistoryEntry, historyActionLabel } from '@/features/inventory/history-format';
import type { ActivityFeedEntry, ItemHistoryEntry } from '@/db/repositories';
import { ACTIVITY_KIND_LABEL, activityKindForAction } from './activity-kind';

/**
 * When an event happened — the first column of both exports.
 *
 * Typed over the base ledger entry and reused by the cross-item feed: a column that only
 * reads {@link ItemHistoryEntry} fields is valid for any row that *has* them, so the two
 * exports share these definitions instead of restating them side by side.
 */
const WHEN_COLUMN: TabularColumn<ItemHistoryEntry> = {
  header: 'When',
  value: (e) => isoTimestamp(e.createdAt),
};

/**
 * What happened — the kind the filter chips group by (which on screen is a filter rather
 * than a column, and is what makes the file sortable), the action, its note and its deltas.
 *
 * The two deltas are split into **separate raw-number columns** rather than reproducing the
 * screen's single signed badge: that badge renders a true minus sign (`−`, U+2212) for a loss,
 * which a spreadsheet reads as text rather than a negative number. A file is for arithmetic, so
 * it carries the stored figures unchanged and lets the reader's tool format them.
 */
const EVENT_COLUMNS: readonly TabularColumn<ItemHistoryEntry>[] = [
  { header: 'Kind', value: (e) => ACTIVITY_KIND_LABEL[activityKindForAction(e.action)] },
  { header: 'Action', value: (e) => historyActionLabel(e.action) },
  { header: 'Detail', value: (e): TabularCell => describeHistoryEntry(e).detail },
  { header: 'Quantity change', value: (e): TabularCell => e.quantityDelta },
  { header: 'Value change', value: (e): TabularCell => e.netValueDelta },
];

/**
 * The cross-item feed's columns: the event columns, with the owning item's name spliced in
 * after the timestamp — the one thing a global feed carries that a single item's log cannot.
 *
 * @internal Exported for unit tests only.
 */
export function activityExportColumns(): readonly TabularColumn<ActivityFeedEntry>[] {
  return [WHEN_COLUMN, { header: 'Item', value: (e) => e.itemName }, ...EVENT_COLUMNS];
}

/**
 * One item's Activity Log columns (issue #620) — the same event columns without the item
 * name, which every row of a per-item export would repeat.
 *
 * @internal Exported for unit tests only.
 */
export function itemActivityExportColumns(): readonly TabularColumn<ItemHistoryEntry>[] {
  return [WHEN_COLUMN, ...EVENT_COLUMNS];
}

/**
 * How an export of `n` events captions its document formats — shared with the location activity
 * export (issue #693) so all three activity exports caption identically by construction rather
 * than by copies of one ternary that happen to agree today.
 *
 * @internal Exported for the sibling location export only.
 */
export function eventCaption(n: number): string {
  return `${n} ${plural(n, 'event')}`;
}

/** Serialise the activity feed to the chosen format via the shared exporter. */
export function buildActivityExport(
  format: TabularExportFormat,
  entries: readonly ActivityFeedEntry[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, activityExportColumns(), entries, {
    title: 'Activity',
    caption: eventCaption(entries.length),
  });
}

/**
 * Serialise **one item's** Activity Log (issue #620) via the same shared exporter. The item
 * is named in the document title rather than in a column, since every row shares it.
 */
export function buildItemActivityExport(
  format: TabularExportFormat,
  entries: readonly ItemHistoryEntry[],
  itemName: string,
): Promise<TabularExportResult> {
  return buildTabularExport(format, itemActivityExportColumns(), entries, {
    title: `Activity — ${itemName}`,
    caption: eventCaption(entries.length),
  });
}

/** Download file name for the activity feed, e.g. `gubbins-activity-2026-07-25.csv`. */
export function activityExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('activity', extension, date);
}

/**
 * Download file name for one item's Activity Log, e.g. `gubbins-item-activity-2026-07-25.csv`.
 *
 * Deliberately not built from the item's name: a name is free text that can carry path
 * separators, reserved characters or nothing printable at all, and the shared list-export
 * naming is what keeps these files sorting together in a downloads folder.
 */
export function itemActivityExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('item-activity', extension, date);
}
