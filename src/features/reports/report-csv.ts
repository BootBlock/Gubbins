/**
 * Pure CSV builders for the §3 Reports screen (inventory-depth Phase 61). Each report
 * has a flat, spreadsheet-friendly shape (RFC-4180 quoting, CRLF rows), so the Export
 * Wizard can offer a CSV for whichever report is on screen without a parallel export
 * path. Kept free of the DOM/repositories so the serialisation is unit-tested directly;
 * the wizard wires these to its existing `download` side-effect.
 */
import { stripFloatNoise } from '@/lib/float-noise';
import type { ConsumptionRateReport, DeadStockReport, InventoryValueReport, MovementReport } from './reports';
import type { AbcReport } from './abc-analysis';
import type { TurnoverReport } from './turnover';
import type { StockAgingReport } from './stock-aging';
import type { ValuationTrendReport } from './valuation-trend';
import type { HygieneReport } from './data-hygiene';
import { SPEND_SOURCE_LABEL, type SpendReport } from './spend-analytics';

/** The reports a user can export as CSV from the Reports screen. */
export type ReportCsvKind =
  | 'VALUATION'
  | 'CONSUMPTION'
  | 'MOVEMENT'
  | 'DEAD_STOCK'
  | 'ABC'
  | 'TURNOVER'
  | 'AGING'
  | 'VALUATION_TREND'
  | 'DATA_HYGIENE'
  | 'SPEND';

/**
 * Leading characters a spreadsheet may evaluate as a formula on open — the CSV-injection / DDE
 * vector (issue #180). Report rows carry user-controlled text (item names, hygiene sample
 * details), so a string cell beginning with one is neutralised below; RFC-4180 quoting alone
 * does not stop the evaluation. Tab / CR are included because leading whitespace can be stripped
 * before the formula check.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * RFC-4180 cell quoting (mirrors the items-CSV exporter). Numeric cells shed their
 * binary-float noise first (issue #291) so a summed valuation reads `0.3`, not
 * `0.30000000000000004`. A string cell that would open as a formula is first prefixed with a
 * single quote (issue #180) — spreadsheets honour that as "literal text" and hide it on display;
 * numbers are the app's own figures and stay untouched.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const isNumber = typeof value === 'number';
  const raw = isNumber ? String(stripFloatNoise(value)) : String(value);
  const text = !isNumber && FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
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

/** ABC CSV: one row per item, ranked A→C, with its annual value and cumulative share. */
export function buildAbcCsv(report: AbcReport): string {
  const rows: unknown[][] = report.lines.map((l) => [l.tier, l.name, l.annualValue, l.cumulativeShare]);
  return toCsv(['tier', 'item', 'annualValue', 'cumulativeShare'], rows);
}

/** Turnover CSV: one row per item (fastest movers first), then a portfolio total row. */
export function buildTurnoverCsv(report: TurnoverReport): string {
  const rows: unknown[][] = report.lines.map((l) => [l.name, l.cogs, l.avgValue, l.turnover, l.daysOnHand]);
  rows.push(['Total', report.totalCogs, report.totalAvgValue, report.turnover, report.daysOnHand]);
  return toCsv(['item', 'cogs', 'avgValue', 'turnover', 'daysOnHand'], rows);
}

/** Stock-aging CSV: one row per age bucket. */
export function buildAgingCsv(report: StockAgingReport): string {
  const rows: unknown[][] = report.buckets.map((b) => [b.label, b.itemCount, b.quantity, b.value]);
  return toCsv(['bucket', 'itemCount', 'quantity', 'value'], rows);
}

/** Valuation-trend CSV: one row per reconstructed sample (chronological). */
export function buildValuationTrendCsv(report: ValuationTrendReport): string {
  const rows: unknown[][] = report.points.map((p) => [isoDate(p.at), p.value]);
  return toCsv(['date', 'value'], rows);
}

/**
 * Spend CSV: the by-source / by-supplier / by-category breakdowns then the time buckets, each row
 * tagged by dimension, with a leading window total. `share` is a 0..1 fraction (blank for buckets).
 *
 * When orders were excluded for being priced in another currency (issue #285), an `Excluded` row
 * records how many, directly under the total it is missing from — an exported figure is read away
 * from the screen that would otherwise have carried the warning.
 */
export function buildSpendCsv(report: SpendReport): string {
  const rows: unknown[][] = [];
  rows.push(['Total', '', report.total, 1]);
  if (report.excludedForeignCurrency > 0) {
    rows.push(['Excluded', 'Purchase orders in another currency', report.excludedForeignCurrency, '']);
  }
  for (const s of report.bySource) rows.push(['Source', SPEND_SOURCE_LABEL[s.source], s.total, s.share]);
  for (const g of report.bySupplier) rows.push(['Supplier', g.name, g.total, g.share]);
  for (const g of report.byCategory) rows.push(['Category', g.name, g.total, g.share]);
  for (const b of report.buckets) rows.push(['Bucket', isoDate(b.start), b.total, '']);
  return toCsv(['dimension', 'group', 'total', 'share'], rows);
}

/**
 * Data-hygiene CSV: one row per *sampled* flagged item — the issue, the item name and the
 * sample's detail. The per-section count can exceed the rows present (samples are capped), so a
 * leading summary block lists each check's exact total before the detail rows.
 */
export function buildDataHygieneCsv(report: HygieneReport): string {
  const summary: unknown[][] = report.sections.map((s) => ['summary', s.label, s.count, '']);
  const detail: unknown[][] = [];
  for (const s of report.sections) {
    for (const sample of s.samples) detail.push(['item', s.label, sample.name, sample.detail ?? '']);
  }
  return toCsv(['row', 'issue', 'item', 'detail'], [...summary, ...detail]);
}
