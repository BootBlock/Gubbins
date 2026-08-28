/**
 * Shared tabular-import engine (item-agnostic).
 *
 * Turns arbitrary user input — a pasted/typed block of text, or the contents of an
 * uploaded file — into a normalised **header + data-row matrix**, so every importer
 * (the item catalogue importer and the projects BOM importer) can consume one set of
 * format detection, one RFC-4180 codec, and one parser per structured shape rather
 * than each re-implementing its own.
 *
 * Recognised source shapes (auto-detected, or forced by the caller):
 *   - `'csv'`      — comma-separated values.
 *   - `'ssv'`      — semicolon-separated values (common European spreadsheet export).
 *   - `'tsv'`      — tab-separated values (a spreadsheet *paste*).
 *   - `'json'`     — an array of objects (or `{ items: [...] }`); keys become columns.
 *   - `'markdown'` — a GitHub-flavoured pipe table.
 *   - `'html'`     — an HTML `<table>` (as copied from a web page or a rich export).
 *   - `'lines'`    — free-form, one entry per line. This shape is **not tabular**; the
 *                    generic engine does not flatten it (each importer that wants a
 *                    free-form parser owns its own field extraction). {@link extractTableRows}
 *                    returns a note for it.
 *
 * Kept free of React and the DOM — the HTML parser is a small regex reader, not
 * DOMParser — so the whole module unit-tests instantly under Node and never depends on
 * a browser global (§2.4.3 "prioritise native APIs over NPM bloat").
 */

// ---------------------------------------------------------------------------
// Source-format model
// ---------------------------------------------------------------------------

/** The recognised shapes of import input. */
export type ImportFormat = 'csv' | 'ssv' | 'tsv' | 'json' | 'markdown' | 'html' | 'lines';

/** All formats in the order a "Interpret as" picker should list them. */
export const IMPORT_FORMATS: readonly ImportFormat[] = [
  'csv',
  'ssv',
  'tsv',
  'json',
  'markdown',
  'html',
  'lines',
];

/** Human-readable label for each format (used in the import dialog UI). */
export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  csv: 'Comma-separated (CSV)',
  ssv: 'Semicolon-separated',
  tsv: 'Tab-separated (TSV)',
  json: 'JSON',
  markdown: 'Markdown table',
  html: 'HTML table',
  lines: 'Line list (one item per line)',
};

/** The single-character delimiter backing each delimiter-based format. */
const DELIMITERS: Partial<Record<ImportFormat, string>> = {
  csv: ',',
  ssv: ';',
  tsv: '\t',
};

/** Formats whose input is delimiter-separated (and so support a header toggle). */
export function isDelimitedFormat(format: ImportFormat): boolean {
  return format === 'csv' || format === 'ssv' || format === 'tsv';
}

/** Formats laid out as columns (a header + data-row matrix — everything but a line list). */
export function isTabularFormat(format: ImportFormat): boolean {
  return format !== 'lines';
}

// ---------------------------------------------------------------------------
// RFC-4180 delimited codec
// ---------------------------------------------------------------------------

/** The result of reading delimited text: the cell matrix, plus what the codec noticed. */
export interface DelimitedRead {
  /** The parsed rows. */
  readonly rows: string[][];
  /**
   * The text ended while still inside a quoted field, so everything from the opening
   * quote onwards — newlines included — was swallowed into a single cell. The rows are
   * still returned, but their shape past that point does not describe the source.
   */
  readonly unterminatedQuote: boolean;
}

/**
 * Read delimiter-separated text into a matrix of string cells, and report whether the
 * text ended inside a quoted field. Handles quoted fields (with embedded delimiters,
 * doubled-quote escapes and embedded newlines) and CRLF/LF line endings. A trailing
 * blank line is ignored; other rows are preserved verbatim.
 *
 * A `"` is structural **only at the start of a field**. Anywhere else it is literal
 * data — which is what RFC 4180 describes, and what Excel, LibreOffice and the common
 * CSV libraries implement. An inch mark in an unquoted cell (`3/4" ball valve`) is
 * therefore read as itself, rather than opening a quoted field that swallows the rest
 * of the file (issue #591).
 *
 * The delimiter is a single character (`,` for CSV, a tab for TSV). The same RFC-4180
 * quoting rules apply regardless of delimiter, so this one codec serves every
 * delimiter-based import path.
 */
export function readDelimited(text: string, delimiter = ','): DelimitedRead {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  // Nothing has been read into the current field yet — the only position at which a
  // `"` opens a quoted field.
  let atFieldStart = true;

  const pushField = () => {
    row.push(field);
    field = '';
    atFieldStart = true;
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

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // swallow; the following \n (if any) finalises the row
    } else {
      field += ch;
      atFieldStart = false;
    }
  }

  // Flush a final row unless the input ended exactly on a row break.
  if (started || field.length > 0 || row.length > 0) {
    pushRow();
  }

  return { rows, unterminatedQuote: inQuotes };
}

/**
 * Parse delimiter-separated text into a matrix of string cells — {@link readDelimited}
 * without the diagnostics, for the callers that only want the rows.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  return readDelimited(text, delimiter).rows;
}

/**
 * Parse CSV text into a matrix of string cells — the comma-delimited
 * specialisation of {@link parseDelimited}. Kept as a named export because it is
 * the canonical CSV codec re-used across the codebase (BOM + catalogue import).
 */
export function parseCsv(text: string): string[][] {
  return parseDelimited(text, ',');
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** How many leading lines to sample when sniffing a delimiter. */
const DETECTION_SAMPLE_SIZE = 10;

/** Split into non-empty lines, tolerant of CRLF / LF / lone-CR endings. */
function nonEmptyLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
}

/** How well one delimiter fits a sample, and whether quoting had to be ignored to say so. */
interface DelimiterFit {
  /** The sampled rows all yielded the same number (> 1) of columns. */
  readonly consistent: boolean;
  /** That column count. */
  readonly columns: number;
  /** The count came from the quote-blind re-measure, so it is a last resort, not a verdict. */
  readonly quoteBlind: boolean;
}

/** Column widths read by a plain split, ignoring quoting entirely. */
function naiveWidths(sample: string, delimiter: string): number[] {
  return nonEmptyLines(sample).map((line) => line.split(delimiter).length);
}

/**
 * Is a delimiter used consistently across a sample of the text? A block is "consistent" when
 * the sampled rows all yield the same number (> 1) of columns — the signature of tabular data.
 *
 * The sample is read with the real RFC-4180 codec rather than a naive `split`, so a delimiter
 * that appears *inside* a quoted cell (`"£1,234.56"`, a `"R1, R2"` designator) does not
 * unbalance the count and wrongly disqualify a perfectly good CSV. Quoting is the single most
 * common reason a delimiter sniff mis-fires, and every importer inherits the answer, so it is
 * worth reading the sample properly.
 *
 * Only where that reading finds nothing, *and* the sample ended inside an unclosed quote, are
 * the widths re-measured with quoting ignored. The quote has merged every later line into one
 * cell, so the codec is describing the merge rather than the file; the quote-blind widths still
 * show the delimiter, and saying the text is delimited is what lets {@link extractTableRows}
 * report the unclosed quote instead of falling through to a line list and offering each merged
 * line as an item (issue #591). Such an answer is marked `quoteBlind`, because a properly quoted
 * cell holding a delimiter inflates its count — {@link detectDelimited} must not let it outrank
 * a delimiter the codec read cleanly.
 */
function delimiterConsistency(
  sample: string,
  delimiter: string,
  truncated: boolean,
  text: string,
): DelimiterFit {
  const read = readDelimited(sample, delimiter);
  const parsed = read.rows.filter((row) => row.some((c) => c.trim().length > 0));
  // A sample cut off mid-file may have severed the final row (or left a quoted cell unclosed,
  // which swallows the remainder into one field). Its width proves nothing, so drop it — but
  // only while at least one whole row is left to judge by.
  const rows = truncated && parsed.length > 1 ? parsed.slice(0, -1) : parsed;
  const columns = rows.length > 0 ? rows[0]!.length : 0;
  if (columns > 1 && rows.every((row) => row.length === columns)) {
    return { consistent: true, columns, quoteBlind: false };
  }

  // The codec made no sense of the sample. An unclosed quote explains why, and the quote-blind
  // widths may still show a table. Two lines minimum: a single line carrying a stray quote is
  // far more likely a free-form note than a table, and a line list is the kinder reading of it.
  // A quoted cell that closes *past* the sample looks identical here to one that never closes,
  // and the difference decides everything: extraction reads the whole text, so a quote that does
  // close leaves it no defect to report and it hands back rows under a delimiter chosen from a
  // merge that never existed. Confirm against the whole text before committing to a quote-blind
  // reading; an untruncated sample is the whole text already.
  if (read.unterminatedQuote && (!truncated || readDelimited(text, delimiter).unterminatedQuote)) {
    const widths = naiveWidths(sample, delimiter);
    const naive = widths.length >= 2 ? widths[0]! : 0;
    if (naive > 1 && widths.every((w) => w === naive)) {
      return { consistent: true, columns: naive, quoteBlind: true };
    }
  }

  return { consistent: false, columns, quoteBlind: false };
}

/**
 * Choose the best delimiter-based format for a block, or `null` when none is cleanly
 * tabular. The delimiter yielding the most consistent columns wins; ties fall to the
 * strongest paste signal (tab, then semicolon, then comma).
 *
 * A delimiter the codec read cleanly always beats one that only fits with quoting ignored,
 * however many columns the latter counts. Whether a `"` opens a field at all depends on the
 * delimiter, so a *wrong* delimiter can see an unclosed quote where the right one sees none —
 * and its quote-blind count, inflated by the delimiters sitting inside quoted cells, would
 * otherwise win and turn a perfectly good file into an unclosed-quote error (issue #591).
 */
function detectDelimited(text: string): ImportFormat | null {
  // Sample whole lines (not the filtered set) so a quoted cell spanning a line break is still
  // readable by the codec; blank rows are dropped after parsing instead.
  const allLines = text.split(/\r\n|\r|\n/);
  const sample = allLines.slice(0, DETECTION_SAMPLE_SIZE).join('\n');
  const truncated = allLines.length > DETECTION_SAMPLE_SIZE;
  if (sample.trim().length === 0) return null;
  const candidates: ReadonlyArray<readonly [ImportFormat, string]> = [
    ['tsv', '\t'],
    ['ssv', ';'],
    ['csv', ','],
  ];
  let best: ImportFormat | null = null;
  let bestColumns = 1;
  let blindBest: ImportFormat | null = null;
  let blindColumns = 1;
  for (const [format, delimiter] of candidates) {
    const fit = delimiterConsistency(sample, delimiter, truncated, text);
    if (!fit.consistent) continue;
    if (fit.quoteBlind) {
      if (fit.columns > blindColumns) {
        blindBest = format;
        blindColumns = fit.columns;
      }
    } else if (fit.columns > bestColumns) {
      best = format;
      bestColumns = fit.columns;
    }
  }
  return best ?? blindBest;
}

/** Does the text parse as a JSON array/object we can turn into rows? */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** A Markdown table separator cell: dashes with optional alignment colons (`:--:`). */
function isSeparatorCell(cell: string): boolean {
  return /^:?-{1,}:?$/.test(cell.trim());
}

/** Split a Markdown table row into trimmed cells, dropping the pipe borders. */
function markdownCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Is this line a Markdown separator row (`|---|:--:|`)? */
function isSeparatorRow(line: string): boolean {
  const cells = markdownCells(line);
  return cells.length > 0 && cells.every(isSeparatorCell);
}

/** Does the text contain a GitHub-flavoured Markdown table (header + `---` rule)? */
function looksLikeMarkdownTable(text: string): boolean {
  const pipeLines = nonEmptyLines(text).filter((l) => l.includes('|'));
  if (pipeLines.length < 2) return false;
  const sepIdx = pipeLines.findIndex(isSeparatorRow);
  return sepIdx >= 1;
}

/** Does the text contain an HTML table (a `<table>` with at least one `<tr>`)? */
function looksLikeHtmlTable(text: string): boolean {
  return /<table[\s>]/i.test(text) && /<tr[\s>]/i.test(text);
}

/**
 * Sniff the most likely {@link ImportFormat} for a block of text. Structured shapes
 * (JSON, HTML tables, Markdown tables) are recognised first; then the strongest
 * consistent delimiter; and anything else falls back to the forgiving line list.
 */
export function detectImportFormat(text: string): ImportFormat {
  if (text.trim().length === 0) return 'lines';
  if (looksLikeJson(text)) return 'json';
  if (looksLikeHtmlTable(text)) return 'html';
  if (looksLikeMarkdownTable(text)) return 'markdown';
  return detectDelimited(text) ?? 'lines';
}

// ---------------------------------------------------------------------------
// Structured parsers (JSON, Markdown, HTML) → header + data-row matrix
// ---------------------------------------------------------------------------

/** A header + data-row matrix produced by a structured parser. */
export interface RowMatrix {
  readonly headerRow: string[];
  readonly dataRows: string[][];
}

/** A plain (non-array) object record. */
type JsonRecord = Record<string, unknown>;

/** Render one JSON value as a flat cell string. */
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value); // nested object/array — surfaced verbatim
}

/** Is a value a plain record (object, not array, not null)? */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coerce arbitrary parsed JSON into the array of elements we will treat as rows:
 * an array is used as-is; an object is unwrapped to its first array-valued property
 * (e.g. `{ items: [...] }`) or, failing that, treated as a single record.
 */
function toJsonElements(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) return value;
    }
    return [data];
  }
  return null;
}

/** The union of object keys across records, in first-seen order. */
function unionKeys(records: readonly JsonRecord[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Parse a JSON document into a header + data-row matrix, or `null` if unusable.
 *
 * @internal Exported for unit tests only.
 */
export function parseJsonRows(text: string): RowMatrix | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const elements = toJsonElements(data);
  if (!elements) return null;

  if (elements.every(isRecord)) {
    const headerRow = unionKeys(elements);
    const dataRows = elements.map((rec) => headerRow.map((key) => jsonCell(rec[key])));
    return { headerRow, dataRows };
  }
  // Array of primitives (or mixed) — treat each element as an item name.
  return { headerRow: ['name'], dataRows: elements.map((el) => [jsonCell(el)]) };
}

/**
 * Parse a GitHub-flavoured Markdown table into a header + data-row matrix.
 *
 * @internal Exported for unit tests only.
 */
export function parseMarkdownRows(text: string): RowMatrix | null {
  const pipeLines = nonEmptyLines(text).filter((l) => l.includes('|'));
  const sepIdx = pipeLines.findIndex(isSeparatorRow);
  if (sepIdx < 1) return null;
  const headerRow = markdownCells(pipeLines[sepIdx - 1]!);
  const dataRows = pipeLines
    .slice(sepIdx + 1)
    .filter((l) => !isSeparatorRow(l))
    .map(markdownCells);
  return { headerRow, dataRows };
}

/** Named HTML entities we decode (the common set found in exported tables). */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the small entity set plus numeric (`&#39;` / `&#x27;`) references. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Strip all `<...>` tags, re-applying the removal until stable so a nested/overlapping
 * payload (e.g. `<scr<script>ipt>`) can't leave a tag behind after a single pass.
 */
function stripHtmlTags(text: string): string {
  let result = text;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/<[^>]*>/g, '');
  } while (result !== previous);
  return result;
}

/** Reduce one HTML cell's inner markup to plain text (strip tags, decode, collapse space). */
function htmlCellText(inner: string): string {
  const withoutTags = stripHtmlTags(
    // <br> becomes a space so multi-line cells don't concatenate words.
    inner.replace(/<br\s*\/?\s*>/gi, ' '),
  );
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/**
 * Parse an HTML `<table>` into a header + data-row matrix with a small, DOM-free regex
 * reader. The first `<tr>` is the header (whether it holds `<th>` or `<td>` cells);
 * subsequent rows are data. Cells are reduced to plain text (tags stripped, entities
 * decoded, whitespace collapsed). Rows with no cells are skipped. Returns `null` when no
 * table row can be found. Best-effort: it is not a full HTML parser, but it handles the
 * tables copied from web pages and produced by spreadsheet / rich-text exports.
 *
 * @internal Exported for unit tests only.
 */
export function parseHtmlRows(text: string): RowMatrix | null {
  // Scope to the first <table>…</table> when present, so surrounding page markup is ignored.
  const tableMatch = /<table[\s\S]*?<\/table>/i.exec(text);
  const scope = tableMatch ? tableMatch[0] : text;

  const rows: string[][] = [];
  for (const rowMatch of scope.matchAll(/<tr[\s>][\s\S]*?<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<t[hd][\s>]([\s\S]*?)<\/t[hd]>/gi)) {
      cells.push(htmlCellText(cellMatch[1] ?? ''));
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return null;
  const [headerRow, ...dataRows] = rows as [string[], ...string[][]];
  return { headerRow, dataRows };
}

// ---------------------------------------------------------------------------
// Generic extraction — text → header + data-row matrix
// ---------------------------------------------------------------------------

/** The normalised, parse-ready form of a tabular import: a header + data-row matrix. */
export interface TableExtraction {
  /** The detected (or caller-forced) source format. */
  readonly format: ImportFormat;
  /** Header cells (real headers, or synthetic `Column N` for a headerless delimited paste). */
  readonly headerRow: readonly string[];
  /** Data rows with fully-blank rows removed; index `i` corresponds to source row `i + 1`. */
  readonly dataRows: readonly string[][];
  /** A non-fatal note when the text could not be parsed as the chosen format. */
  readonly note?: string;
  /**
   * The delimited source ended inside a quoted field, so the rows past that point were
   * merged into one cell and no extraction is offered. Consumers that word their own
   * errors use this to say *which* defect they hit rather than a generic one.
   */
  readonly unterminatedQuote?: boolean;
}

/** Options for {@link extractTableRows}. */
export interface ExtractTableOptions {
  /** Force a specific format, bypassing {@link detectImportFormat}. */
  readonly format?: ImportFormat;
  /**
   * Whether the first row of a *delimited* source is a header row. Defaults to `true`.
   * When `false`, synthetic `Column N` headers are used and every row is treated as data
   * (for headerless CSV/TSV pastes). Ignored for non-delimited formats.
   */
  readonly hasHeader?: boolean;
}

/**
 * What the user is told when a delimited file ends inside an unclosed quote. Exported so
 * the importers that word their own failure messages can reuse it instead of reporting a
 * missing-columns error for a defect that has nothing to do with the columns.
 */
export const UNTERMINATED_QUOTE_NOTE =
  'A quoted value is never closed — the text ends inside a double-quote, so everything after ' +
  'it was read as a single cell. Look for a stray " that opens a cell. Inside a quoted cell, a ' +
  'double-quote you want to keep is written twice, as "".';

/** Build a synthetic header row (`Column 1 … Column n`) for headerless input. */
function syntheticHeaders(width: number): string[] {
  return Array.from({ length: Math.max(width, 1) }, (_, i) => `Column ${i + 1}`);
}

/** An empty extraction carrying a parse note (e.g. malformed JSON, non-tabular input). */
function emptyExtraction(format: ImportFormat, note: string): TableExtraction {
  return { format, headerRow: [], dataRows: [], note };
}

/**
 * Normalise raw import text into a {@link TableExtraction}: detect (or accept) the format
 * and parse it into a header + data-row matrix. Handles only the **tabular** formats
 * (csv/ssv/tsv/json/markdown/html); a free-form `lines` shape is not this engine's concern,
 * so it returns a note directing the caller to its own free-form parser. Never throws — an
 * unparseable structured format yields an empty extraction with a `note`.
 */
export function extractTableRows(text: string, options: ExtractTableOptions = {}): TableExtraction {
  const format = options.format ?? detectImportFormat(text);
  const hasHeader = options.hasHeader ?? true;

  if (format === 'lines') {
    return emptyExtraction(
      'lines',
      'This looks like a free-form list rather than a table — no columns were detected.',
    );
  }

  if (format === 'json') {
    const parsed = parseJsonRows(text);
    return parsed
      ? { format, headerRow: parsed.headerRow, dataRows: parsed.dataRows }
      : emptyExtraction('json', 'That does not look like valid JSON (expected an array of objects).');
  }

  if (format === 'markdown') {
    const parsed = parseMarkdownRows(text);
    return parsed
      ? { format, headerRow: parsed.headerRow, dataRows: parsed.dataRows }
      : emptyExtraction(
          'markdown',
          'No Markdown table found — needs a header row and a "| --- |" separator.',
        );
  }

  if (format === 'html') {
    const parsed = parseHtmlRows(text);
    return parsed
      ? { format, headerRow: parsed.headerRow, dataRows: parsed.dataRows }
      : emptyExtraction('html', 'No HTML table found — expected a <table> with <tr> rows.');
  }

  // Delimited: csv / ssv / tsv.
  const delimiter = DELIMITERS[format] ?? ',';
  const read = readDelimited(text, delimiter);
  // An unclosed quote has merged every line after it into one cell, so the rows no longer
  // describe the file. Offering them anyway is the silent-corruption path of issue #591 — a
  // plausible-looking preview over junk — so the extraction is empty and the defect is named.
  if (read.unterminatedQuote) {
    return { ...emptyExtraction(format, UNTERMINATED_QUOTE_NOTE), unterminatedQuote: true };
  }
  const allRows = read.rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (hasHeader) {
    return { format, headerRow: allRows[0] ?? [], dataRows: allRows.slice(1) };
  }
  const width = allRows.reduce((max, r) => Math.max(max, r.length), 0);
  return { format, headerRow: syntheticHeaders(width), dataRows: allRows };
}
