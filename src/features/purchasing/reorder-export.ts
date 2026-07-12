/**
 * Reorder / shopping-list export (Phase 65; multi-format via issue #27).
 *
 * Flattens the supplier-grouped reorder plan into one row per item line — the supplier name
 * is repeated on each row so the file is self-contained for a spreadsheet or order portal —
 * and serialises it through the shared tabular exporter, so CSV / TSV / Markdown / HTML all
 * come from one column model. Pure (no React, no DB) so it is unit-testable directly.
 */
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import type { ReorderPlanGroup } from './reorder-plan';

/** One flat export row: a reorder line with its supplier name denormalised onto it. */
export interface ReorderExportRow {
  readonly supplier: string;
  readonly item: string;
  readonly orderQty: number;
  readonly unitCost: number | null;
}

/** Flatten the grouped plan into self-contained per-line rows (supplier repeated per row). */
export function flattenReorderPlan(groups: readonly ReorderPlanGroup[]): ReorderExportRow[] {
  const rows: ReorderExportRow[] = [];
  for (const group of groups) {
    for (const line of group.lines) {
      rows.push({
        supplier: group.supplierName,
        item: line.itemName,
        orderQty: line.orderQty,
        unitCost: line.unitCost,
      });
    }
  }
  return rows;
}

/** Export columns — headers kept stable (`supplier`/`item`/`orderQty`/`unitCost`) for round-trips. */
export function reorderExportColumns(): readonly TabularColumn<ReorderExportRow>[] {
  return [
    { header: 'supplier', value: (r) => r.supplier },
    { header: 'item', value: (r) => r.item },
    { header: 'orderQty', value: (r) => r.orderQty },
    { header: 'unitCost', value: (r) => r.unitCost },
  ];
}

/** Serialise the reorder / shopping list to the chosen format via the shared exporter. */
export function buildReorderExport(
  groups: readonly ReorderPlanGroup[],
  format: TabularExportFormat,
): TabularExportResult {
  const rows = flattenReorderPlan(groups);
  return buildTabularExport(format, reorderExportColumns(), rows, {
    title: 'Reorder & shopping list',
    caption: `${rows.length} line${rows.length === 1 ? '' : 's'}`,
  });
}
