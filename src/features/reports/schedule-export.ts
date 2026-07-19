/**
 * Insurance / estate schedule export (issue #163): serialise the whole schedule to a
 * downloadable file.
 *
 * This is the route for a schedule too large to print. Above a few thousand assets a printed
 * schedule runs to hundreds or thousands of pages, and building that document in the DOM is what
 * a browser cannot survive — but serialising the same rows to text scales fine, and a file is
 * more useful to an insurer or executor anyway: it can be searched, re-totalled, and printed in
 * part.
 *
 * Pure — it maps resolved {@link ScheduleLine}s onto the shared tabular column model and hands
 * them to the generic serialisers in `@/features/export/tabular-export`, so every format comes
 * from one column definition. Kept free of React and repositories.
 */
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { WARRANTY_STATUS_LABEL } from '@/features/inventory/components/inventory-ui';
import { CONDITION_LABELS } from '@/features/inventory/components/inventory-ui';
import type { InsuranceScheduleSummary, ScheduleLine } from './insurance-schedule';

/** One exported row: a schedule line flattened with the room it sits in. */
export interface ScheduleExportRow {
  readonly room: string;
  readonly line: ScheduleLine;
}

/**
 * The export columns — the schedule's own columns, minus the photo (a spreadsheet cell cannot
 * carry one) and plus the room, which on screen is a group heading rather than a column.
 *
 * Money and quantities stay raw numbers so the file is machine-readable and locale-independent;
 * the reader's spreadsheet formats them.
 *
 * @internal Exported for unit tests only.
 */
export function scheduleExportColumns(): readonly TabularColumn<ScheduleExportRow>[] {
  return [
    { header: 'Room', value: (r) => r.room },
    { header: 'Item', value: (r) => r.line.name },
    { header: 'Serial', value: (r) => r.line.serialNo },
    { header: 'Quantity', value: (r) => r.line.quantity },
    { header: 'Purchase price', value: (r) => r.line.purchasePrice },
    { header: 'Acquired', value: (r) => r.line.acquiredAt },
    { header: 'Warranty', value: (r) => WARRANTY_STATUS_LABEL[r.line.warranty] },
    { header: 'Condition', value: (r) => (r.line.condition ? CONDITION_LABELS[r.line.condition] : null) },
    { header: 'Replacement value', value: (r) => r.line.replacementValue },
  ];
}

/**
 * Flatten the schedule into export rows, in the document's own order: rooms in hierarchy order,
 * lines within a room as the document lists them. A room with no loaded lines contributes
 * nothing rather than an empty placeholder row.
 */
export function scheduleExportRows(
  summary: InsuranceScheduleSummary,
  linesByLocation: ReadonlyMap<string | null, readonly ScheduleLine[]>,
): ScheduleExportRow[] {
  return summary.groups.flatMap((group) =>
    (linesByLocation.get(group.locationId) ?? []).map((line) => ({ room: group.locationPath, line })),
  );
}

/** Serialise the schedule to `format`. */
export function buildScheduleExport(
  format: TabularExportFormat,
  summary: InsuranceScheduleSummary,
  linesByLocation: ReadonlyMap<string | null, readonly ScheduleLine[]>,
): Promise<TabularExportResult> {
  const rows = scheduleExportRows(summary, linesByLocation);
  return buildTabularExport(format, scheduleExportColumns(), rows, {
    title: 'Insurance & estate schedule',
    caption: `${rows.length} assets`,
  });
}

/** Download file name for the schedule, e.g. `insurance-schedule.csv`. */
export function scheduleExportFilename(extension: string): string {
  return `insurance-schedule.${extension}`;
}
