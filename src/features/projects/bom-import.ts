/**
 * BOM import parsing (spec §4 "BOM Ingress" — Standard CSV/KiCad Import).
 *
 * A dependency-free, RFC-4180-ish CSV reader plus a column-mapping layer that
 * recognises the common KiCad and generic BOM export headers. Kept pure (no DB,
 * no React) so it unit-tests instantly and honours the §2.4.3 "prioritise native
 * APIs over NPM bloat" mandate. Auto-matching parsed lines to local items (by
 * MPN/alias) is performed by `ItemRepository.findByMatchKey` at import time.
 */

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

/**
 * Parse delimiter-separated text into a matrix of string cells. Handles quoted
 * fields (with embedded delimiters, doubled-quote escapes and embedded newlines)
 * and CRLF/LF line endings. A trailing blank line is ignored; other rows are
 * preserved verbatim.
 *
 * The delimiter is a single character (`,` for CSV, `\t` for TSV). The same
 * RFC-4180 quoting rules apply regardless of delimiter, so this one codec serves
 * both the comma- and tab-separated import paths (Phase: generalised import).
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    started = true;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // swallow; the following \n (if any) finalises the row
    } else {
      field += ch;
    }
  }

  // Flush a final row unless the input ended exactly on a row break.
  if (started || field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows;
}

/**
 * Parse CSV text into a matrix of string cells — the comma-delimited
 * specialisation of {@link parseDelimited}. Kept as a named export because it is
 * the canonical CSV codec re-used across the codebase (BOM + catalog import).
 */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text, ',');
}

/** Normalise a header cell to a comparison key: lowercase, alphanumeric only. */
function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Header synonyms (already passed through {@link headerKey}) → logical column. */
const COLUMN_SYNONYMS: Record<string, ReadonlyArray<string>> = {
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

type LogicalColumn = keyof typeof COLUMN_SYNONYMS;

/** Resolve a header row into a map of logical column → cell index. */
function mapHeaders(header: readonly string[]): Partial<Record<LogicalColumn, number>> {
  const map: Partial<Record<LogicalColumn, number>> = {};
  header.forEach((cell, index) => {
    const key = headerKey(cell);
    for (const [logical, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
      if (map[logical as LogicalColumn] === undefined && synonyms.includes(key)) {
        map[logical as LogicalColumn] = index;
      }
    }
  });
  return map;
}

function cell(row: readonly string[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const value = (row[index] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Parse a CSV/KiCad BOM into structured lines. The first non-empty row is treated
 * as the header. Quantities default to 1 when missing or unparseable; the
 * description falls back to the Value column. Throws {@link BomImportError} when
 * the file is empty or carries no recognisable columns.
 */
export function parseBom(text: string): ParsedBomLine[] {
  if (text.trim().length === 0) {
    throw new BomImportError('The BOM file is empty.');
  }

  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim().length > 0));
  if (rows.length === 0) {
    throw new BomImportError('The BOM file has no data rows.');
  }

  const header = rows[0]!;
  const dataRows = rows.slice(1);
  const columns = mapHeaders(header);

  // We need at least one identifying column to make a usable BOM line.
  if (
    columns.mpn === undefined &&
    columns.description === undefined &&
    columns.designator === undefined
  ) {
    throw new BomImportError(
      'No recognisable BOM columns found. Expected a header with Reference/MPN/Description (or similar).',
    );
  }

  const lines: ParsedBomLine[] = [];
  for (const row of dataRows) {
    const designator = cell(row, columns.designator);
    const mpn = cell(row, columns.mpn);
    const manufacturer = cell(row, columns.manufacturer);
    const description = cell(row, columns.description);
    if (!designator && !mpn && !manufacturer && !description) continue; // blank row

    const qtyText = cell(row, columns.quantity);
    const parsedQty = qtyText ? Number.parseInt(qtyText, 10) : NaN;
    const requiredQty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;

    lines.push({ designator, mpn, manufacturer, description, requiredQty });
  }

  return lines;
}
