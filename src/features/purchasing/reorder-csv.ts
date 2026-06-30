/**
 * Pure CSV builder for the Reorder / Shopping-list tab (Phase 65).
 *
 * Produces one flat row per item-line across all supplier groups (supplier name is
 * repeated on each row for easy pivot filtering in a spreadsheet). RFC-4180 quoting
 * mirrors the existing `report-csv.ts` pattern — no new dependency introduced.
 *
 * Kept dependency-free (no React, no DB) so it is unit-testable directly.
 */
import type { ReorderPlanGroup } from './reorder-plan';

/** RFC-4180 cell quoting — mirrors `report-csv.ts`. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.join(','), ...rows.map((r) => r.map(cell).join(','))];
  return lines.join('\r\n');
}

/**
 * Reorder shopping-list CSV: one row per item line, with the supplier name repeated on each
 * row so the file is self-contained for import into a spreadsheet or order portal.
 *
 * Columns: `supplier`, `item`, `orderQty`, `unitCost`.
 */
export function buildReorderCsv(groups: readonly ReorderPlanGroup[]): string {
  const rows: unknown[][] = [];
  for (const group of groups) {
    for (const line of group.lines) {
      rows.push([group.supplierName, line.itemName, line.orderQty, line.unitCost]);
    }
  }
  return toCsv(['supplier', 'item', 'orderQty', 'unitCost'], rows);
}
