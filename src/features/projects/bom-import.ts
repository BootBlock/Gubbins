/**
 * BOM import parsing (spec §4 "BOM Ingress").
 *
 * A column-mapping layer that recognises the common KiCad and generic BOM export
 * headers and turns a parsed table into {@link ParsedBomLine}s. The generic "text →
 * header + data-row matrix" work — format detection, the RFC-4180 codec and the
 * JSON / Markdown / HTML table parsers — is delegated to the shared, item-agnostic
 * {@link module:features/import/tabular} engine (the same one the item importer uses),
 * so a BOM can arrive as CSV/TSV/SSV, a spreadsheet paste, JSON, a Markdown table, or
 * an HTML table — not just comma-separated CSV.
 *
 * Kept pure (no DB, no React) so it unit-tests instantly and honours the §2.4.3
 * "prioritise native APIs over NPM bloat" mandate. Auto-matching parsed lines to local
 * items (by MPN/alias) is performed by `ItemRepository.findByMatchKey` at import time.
 */
import {
  detectImportFormat,
  extractTableRows,
  isTabularFormat,
  parseCsv,
  parseDelimited,
  type ImportFormat,
} from '@/features/import/tabular';
import { cellAt, cellAsCount, mapColumns, type ColumnSynonyms } from '@/features/import/columns';

// Re-export the shared codec from here so existing importers keep their import site
// (the RFC-4180 reader moved to features/import/tabular; these are thin pass-throughs).
export { parseCsv, parseDelimited };

/** A row parsed from a BOM file, before matching against local inventory. */
export interface ParsedBomLine {
  readonly designator: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly description: string | null;
  readonly requiredQty: number;
}

/** Raised when a BOM file is empty or has no recognisable columns. */
export class BomImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BomImportError';
  }
}

/** The logical columns a BOM line is built from. */
type LogicalColumn = 'designator' | 'mpn' | 'manufacturer' | 'description' | 'quantity';

/** Header synonyms (already in `headerKey` form) → logical column. */
const COLUMN_SYNONYMS: ColumnSynonyms<LogicalColumn> = {
  designator: ['reference', 'references', 'designator', 'designators', 'refdes', 'ref'],
  mpn: [
    'mpn',
    'manufacturerpartnumber',
    'mfrpartnumber',
    'mfgpartnumber',
    'manufacturerpartno',
    'partnumber',
    'mfrpn',
    'mfgpn',
  ],
  manufacturer: ['manufacturer', 'mfr', 'mfg', 'manufacturername', 'mfgname', 'mfrname'],
  description: ['description', 'comment', 'name', 'partdescription', 'value'],
  quantity: ['quantity', 'qty', 'qnty', 'count', 'amount'],
};

/** The error message shown when the input carries no columns a BOM can be built from. */
const NO_COLUMNS_MESSAGE =
  'No recognisable BOM columns found. Expected a header with Reference/MPN/Description (or similar).';

/** Options for {@link parseBom}. */
export interface ParseBomOptions {
  /**
   * Force a specific source format, bypassing auto-detection (mirrors the item importer's
   * "Interpret as"). Only tabular formats make sense for a BOM; a free-form `'lines'`
   * value is treated as "no table" and rejected with a clear error.
   */
  readonly format?: ImportFormat;
  /**
   * Whether the first row of a *delimited* source is a header row. Defaults to `true`
   * (a BOM export always names its columns). Ignored for the structured formats.
   */
  readonly hasHeader?: boolean;
}

/**
 * Parse a bill of materials into structured lines. The source format is auto-detected
 * (CSV/SSV/TSV, JSON, a Markdown table, or an HTML table) — or forced via
 * `options.format` — and reduced to a header + data-row matrix by the shared
 * {@link extractTableRows} engine; the first row is the header. Quantities default to 1
 * when missing or unparseable; the description falls back to the Value column. Throws
 * {@link BomImportError} when the file is empty, is not a recognisable table, or carries
 * no columns a BOM line can be built from.
 */
export function parseBom(text: string, options: ParseBomOptions = {}): ParsedBomLine[] {
  if (text.trim().length === 0) {
    throw new BomImportError('The BOM file is empty.');
  }

  // A forced free-form format can never yield a BOM table.
  if (options.format !== undefined && !isTabularFormat(options.format)) {
    throw new BomImportError(NO_COLUMNS_MESSAGE);
  }

  // Resolve the source format. A BOM is always a table, so when auto-detection is
  // inconclusive ('lines') — which the naive delimiter sniff reports for a comma CSV whose
  // quoted cells (e.g. a "R1, R2" designator) unbalance the column count — fall back to
  // CSV, the historical default and the dominant KiCad/spreadsheet export.
  const detected = options.format ?? detectImportFormat(text);
  const format: ImportFormat = isTabularFormat(detected) ? detected : 'csv';

  const extraction = extractTableRows(text, {
    format,
    ...(options.hasHeader !== undefined ? { hasHeader: options.hasHeader } : {}),
  });

  // A structured parse failed, or the text is a free-form list rather than a table:
  // surface the classic "no recognisable columns" error so the guidance is BOM-specific.
  if (extraction.note !== undefined || extraction.headerRow.length === 0) {
    throw new BomImportError(NO_COLUMNS_MESSAGE);
  }

  const columns = mapColumns(extraction.headerRow, COLUMN_SYNONYMS);

  // We need at least one identifying column to make a usable BOM line.
  if (columns.mpn === undefined && columns.description === undefined && columns.designator === undefined) {
    throw new BomImportError(NO_COLUMNS_MESSAGE);
  }

  const lines: ParsedBomLine[] = [];
  for (const row of extraction.dataRows) {
    const designator = cellAt(row, columns.designator);
    const mpn = cellAt(row, columns.mpn);
    const manufacturer = cellAt(row, columns.manufacturer);
    const description = cellAt(row, columns.description);
    if (!designator && !mpn && !manufacturer && !description) continue; // blank row

    lines.push({
      designator,
      mpn,
      manufacturer,
      description,
      requiredQty: cellAsCount(row, columns.quantity, 1),
    });
  }

  return lines;
}
