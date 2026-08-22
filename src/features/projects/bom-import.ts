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
import {
  cellAt,
  mapColumns,
  problemExcerpt,
  readCountCell,
  textCellProblem,
  type ColumnSynonyms,
  type ImportRowProblem,
} from '@/features/import/columns';
import { TEXT_LIMITS } from '@/lib/text-limits';

// Re-export the shared codec from here so existing importers keep their import site
// (the RFC-4180 reader moved to features/import/tabular; these are thin pass-throughs).
export { parseCsv, parseDelimited };

/** A row parsed from a BOM file, before matching against local inventory. */
export interface ParsedBomLine {
  readonly designator: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly description: string | null;
  /**
   * How many of the part this build needs. **Zero is a real value** — a BOM line marked "not
   * needed this build" is stored as it was written rather than promoted to one unit
   * (`project_bom_lines.required_qty >= 0`, issue #350).
   */
  readonly requiredQty: number;
}

/** The outcome of parsing a BOM: the lines to import, plus the rows that could not become one. */
export interface BomParseResult {
  readonly lines: readonly ParsedBomLine[];
  /** Rows the file described whose quantity could not be honoured — listed in the preview. */
  readonly problems: readonly ImportRowProblem[];
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
 * {@link extractTableRows} engine; the first row is the header. The description falls back to
 * the Value column.
 *
 * A quantity is only defaulted to 1 where the file supplied none (no column, or a blank cell).
 * A quantity the file *did* state but that a required count cannot express — a negative, a
 * fraction, or text that is not a number — leaves its row out and is reported in
 * {@link BomParseResult.problems} rather than being replaced by a default the user would have
 * no way of spotting (issue #350). A quantity of `0` is not a problem here: a BOM line may
 * legitimately require none of a part, so it imports as zero.
 *
 * Throws {@link BomImportError} when the file is empty, is not a recognisable table, or carries
 * no columns a BOM line can be built from.
 */
export function parseBom(text: string, options: ParseBomOptions = {}): BomParseResult {
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
  const problems: ImportRowProblem[] = [];
  for (const [index, row] of extraction.dataRows.entries()) {
    const designator = cellAt(row, columns.designator);
    const mpn = cellAt(row, columns.mpn);
    const manufacturer = cellAt(row, columns.manufacturer);
    const description = cellAt(row, columns.description);
    if (!designator && !mpn && !manufacturer && !description) continue; // blank row

    // The columns these cells land in are length-bounded (issue #346), and an import writes past
    // the control and the repository that normally report an over-long entry. Left to the column
    // CHECK, one runaway cell would abort the write part-way through a file whose earlier lines
    // had already been added; reported here it costs its own row, like an unusable quantity.
    const overLong =
      textCellProblem(designator, TEXT_LIMITS.line) ??
      textCellProblem(mpn, TEXT_LIMITS.line) ??
      textCellProblem(manufacturer, TEXT_LIMITS.line) ??
      textCellProblem(description, TEXT_LIMITS.note);
    if (overLong) {
      problems.push({
        sourceRow: index + 1,
        // Excerpted, because the label may itself be the over-long cell.
        label: problemExcerpt(designator ?? mpn ?? description ?? manufacturer ?? ''),
        ...overLong,
      });
      continue;
    }

    // `zeroAllowed`: a BOM line requiring none of a part is a normal way to mark it "not needed
    // this build", and the column stores it, so it is imported as written rather than reported.
    const quantity = readCountCell(row, columns.quantity, { fallback: 1, zeroAllowed: true });
    if (!quantity.ok) {
      problems.push({
        sourceRow: index + 1,
        // One of these is non-null: a row with none of them was skipped as blank above.
        label: designator ?? mpn ?? description ?? manufacturer ?? '',
        reason: quantity.reason,
        value: quantity.value,
      });
      continue;
    }

    lines.push({ designator, mpn, manufacturer, description, requiredQty: quantity.value });
  }

  return { lines, problems };
}
