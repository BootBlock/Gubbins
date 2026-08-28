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
import { normaliseCurrencyCode } from '@/lib/money';
import type { ReorderPlanGroup } from './reorder-plan';

/** One flat export row: a reorder line with its supplier name denormalised onto it. */
export interface ReorderExportRow {
  readonly supplier: string;
  readonly item: string;
  readonly orderQty: number;
  readonly unitCost: number | null;
  /**
   * The ISO code {@link unitCost} is quoted in — the supplier's own, or the base currency for a
   * line that names none. A bare cost column told a mixed-currency plan's two prices apart by
   * nothing at all once it left the app (issue #569), so the code travels with the figure.
   * Blank only when the line has no cost and the base currency is unknown.
   */
  readonly currency: string;
}

/**
 * Flatten the grouped plan into self-contained per-line rows (supplier repeated per row).
 *
 * The supplier column carries the display **name**, never the group's `supplierId` — this file
 * is read by a person or pasted into an order portal, where an opaque id means nothing.
 *
 * @internal Exported for unit tests only.
 */
export function flattenReorderPlan(
  groups: readonly ReorderPlanGroup[],
  baseCurrency: string | null = null,
): ReorderExportRow[] {
  const base = normaliseCurrencyCode(baseCurrency) ?? '';
  const rows: ReorderExportRow[] = [];
  for (const group of groups) {
    for (const line of group.lines) {
      rows.push({
        supplier: group.supplierName,
        item: line.itemName,
        orderQty: line.orderQty,
        unitCost: line.unitCost,
        // A line carrying no code of its own is in the base currency (the stored convention),
        // so the base code is written out rather than left blank — a blank in a spreadsheet
        // reads as "unknown", which is a different fact.
        currency: line.currency ?? base,
      });
    }
  }
  return rows;
}

/**
 * Export columns — headers kept stable (`supplier`/`item`/`orderQty`/`unitCost`/`currency`) for
 * round-trips. `currency` was appended rather than inserted so an existing consumer reading by
 * position still finds the first four where they were (issue #569).
 *
 * @internal Exported for unit tests only.
 */
export function reorderExportColumns(): readonly TabularColumn<ReorderExportRow>[] {
  return [
    { header: 'supplier', value: (r) => r.supplier },
    { header: 'item', value: (r) => r.item },
    { header: 'orderQty', value: (r) => r.orderQty },
    { header: 'unitCost', value: (r) => r.unitCost },
    { header: 'currency', value: (r) => r.currency },
  ];
}

/**
 * Serialise the reorder / shopping list to the chosen format via the shared exporter.
 *
 * `baseCurrency` names what a line with no currency of its own is quoted in, so every row
 * states a currency; pass the user's configured base (the pure module has no preferences to
 * read one from).
 */
export function buildReorderExport(
  groups: readonly ReorderPlanGroup[],
  format: TabularExportFormat,
  baseCurrency: string | null = null,
): Promise<TabularExportResult> {
  const rows = flattenReorderPlan(groups, baseCurrency);
  return buildTabularExport(format, reorderExportColumns(), rows, {
    title: 'Reorder & shopping list',
    caption: `${rows.length} line${rows.length === 1 ? '' : 's'}`,
  });
}
