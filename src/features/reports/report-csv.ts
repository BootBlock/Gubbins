/**
 * Pure CSV builders for the §3 Reports screen (inventory-depth Phase 61). Each report
 * has a flat, spreadsheet-friendly shape (RFC-4180 quoting, CRLF rows), so the Export
 * Wizard can offer a CSV for whichever report is on screen without a parallel export
 * path. Kept free of the DOM/repositories so the serialisation is unit-tested directly;
 * the wizard wires these to its existing `download` side-effect.
 */
import type {
  ConsumptionRateReport,
  DeadStockReport,
  InventoryValueReport,
  MovementReport,
} from './reports';

/** The reports a user can export as CSV from the Reports screen. */
export type ReportCsvKind = 'VALUATION' | 'CONSUMPTION' | 'MOVEMENT' | 'DEAD_STOCK';

/** RFC-4180 cell quoting (mirrors the items-CSV exporter). */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.join(','), ...rows.map((r) => r.map(cell).join(','))];
  return lines.join('\r\n');
}

/** A date-only ISO stamp (UTC) for window/boundary columns. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Valuation CSV: the category breakdown then the location breakdown, tagged by dimension. */
export function buildValuationCsv(report: InventoryValueReport): string {
  const rows: unknown[][] = [];
  for (const g of report.byCategory) rows.push(['Category', g.name, g.quantity, g.value]);
  for (const g of report.byLocation) rows.push(['Location', g.name, g.quantity, g.value]);
  return toCsv(['dimension', 'group', 'quantity', 'value'], rows);
}

/** Consumption CSV: a single summary row for the window. */
export function buildConsumptionCsv(report: ConsumptionRateReport): string {
  return toCsv(
    ['windowStart', 'windowEnd', 'windowDays', 'totalConsumed', 'perDay'],
    [
      [
        isoDate(report.windowStart),
        isoDate(report.windowEnd),
        report.windowDays,
        report.totalConsumed,
        report.perDay,
      ],
    ],
  );
}

/** Movement CSV: one row per time bucket (ins/outs), then a totals row. */
export function buildMovementCsv(report: MovementReport): string {
  const rows: unknown[][] = report.buckets.map((b) => [isoDate(b.start), isoDate(b.end), b.in, b.out]);
  rows.push(['Total', '', report.totalIn, report.totalOut]);
  return toCsv(['bucketStart', 'bucketEnd', 'in', 'out'], rows);
}

/** Dead-stock CSV: one row per idle item, most idle first. */
export function buildDeadStockCsv(report: DeadStockReport): string {
  const rows: unknown[][] = report.lines.map((l) => [l.name, l.quantity, l.idleDays, l.value]);
  return toCsv(['item', 'quantity', 'idleDays', 'value'], rows);
}
