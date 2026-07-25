/**
 * Alert-centre export (issue #132): serialise the current alert list to a downloadable file —
 * a to-do list to work through away from the app, or to hand to whoever does the ordering.
 *
 * Pure: it maps {@link Alert}s onto the shared tabular column model and hands them to the
 * generic serialisers in `@/features/export/tabular-export`. Kept free of React and repositories
 * — the screen supplies the rows it is showing.
 */
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { listExportFilename } from '@/features/export/export-every-page';
import { ALERT_KIND_LABEL, ALERT_SEVERITY_LABEL, type Alert } from './alerts';

/**
 * The export columns — what each alert card shows, flattened.
 *
 * `Due` carries the alert's own ISO-8601 `dueAt` verbatim: it is already the locale-independent
 * form, and it is the field the feed sorts by, so a spreadsheet sorted on this column reproduces
 * the screen's "soonest first" order. The deep-link route is deliberately omitted — an in-app
 * path means nothing outside the app.
 *
 * @internal Exported for unit tests only.
 */
export function alertsExportColumns(): readonly TabularColumn<Alert>[] {
  return [
    { header: 'Kind', value: (a) => ALERT_KIND_LABEL[a.kind] },
    { header: 'Severity', value: (a) => ALERT_SEVERITY_LABEL[a.severity] },
    { header: 'Alert', value: (a) => a.title },
    { header: 'Detail', value: (a) => a.detail },
    { header: 'Due', value: (a) => a.dueAt },
    { header: 'Item', value: (a) => a.target.itemName ?? null },
  ];
}

/**
 * Serialise the alert list to the chosen format via the shared exporter.
 *
 * The rows are the alerts the screen is showing — i.e. with snoozed and dismissed ones already
 * filtered out. That is deliberate: the file is the work list the user is looking at, and an
 * alert they have explicitly set aside reappearing in the export would defeat the point of
 * setting it aside.
 */
export function buildAlertsExport(
  format: TabularExportFormat,
  alerts: readonly Alert[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, alertsExportColumns(), alerts, {
    title: 'Alerts',
    caption: `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the alert list, e.g. `gubbins-alerts-2026-07-25.csv`. */
export function alertsExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('alerts', extension, date);
}
