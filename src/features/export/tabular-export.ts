/**
 * Pure tabular serialisers shared by every "list → a file" export (issue #27).
 *
 * A single column model ({@link TabularColumn}) feeds four output formats — delimited
 * (CSV / TSV), a GitHub-flavoured Markdown table, and a self-contained printable HTML
 * document — so a new tabular export (the project BOM, the items CSV, …) declares its
 * columns once and gets every format for free, with the quoting / escaping written and
 * unit-tested in one place. Kept free of React, repositories and the DOM.
 */

import { stripFloatNoise } from '@/lib/float-noise';

/** A cell's raw value before serialisation; null / undefined render as an empty cell. */
export type TabularCell = string | number | boolean | null | undefined;

export interface TabularColumn<T> {
  /** The column heading (also escaped per the chosen format). */
  readonly header: string;
  /** Extract this column's value from a row. */
  readonly value: (row: T) => TabularCell;
}

/**
 * Normalise a cell to its string form; null / undefined become an empty string. Numbers
 * lose their binary-float noise first (issue #291), so a computed money figure reads
 * `0.3` rather than `0.30000000000000004` in every text format.
 */
function cellText(value: TabularCell): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? String(stripFloatNoise(value)) : String(value);
}

/**
 * Leading characters a spreadsheet (Excel, LibreOffice, Sheets) may treat as the start of a
 * formula when it opens a CSV / TSV cell — the CSV-injection / DDE vector (issue #180). RFC-4180
 * quoting does *not* defuse this, so a cell beginning with one is neutralised below. Tab and CR
 * are included because some spreadsheets strip leading whitespace before deciding a `=…` cell is
 * a formula.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Defuse spreadsheet formula injection: prefix a formula-triggering cell with a single quote,
 * which spreadsheets honour as "treat the rest as literal text" and hide on display. Applied only
 * to *string* cells — numbers and booleans are the app's own computed values (a spreadsheet reads
 * a leading-`-` number such as `-5` as the value, never a formula), so leaving them untouched
 * keeps genuine figures intact.
 */
function neutraliseFormula(value: TabularCell, text: string): string {
  return typeof value === 'string' && FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/**
 * Quote a delimited-file cell per RFC-4180: wrap in double quotes (doubling any inner
 * quote) when it contains the delimiter, a quote, or a CR / LF. Shared by CSV (comma)
 * and TSV (tab) so a value carrying the delimiter round-trips intact. A leading formula
 * trigger is neutralised first (issue #180) so opening the file can't execute a cell.
 */
function delimitedCell(value: TabularCell, delimiter: string): string {
  const text = neutraliseFormula(value, cellText(value));
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialise rows to a delimited table with CRLF row separators. `delimiter` is `,` for
 * CSV or a tab for TSV; both share the RFC-4180 quoting above.
 *
 * @internal Exported for unit tests only.
 */
export function toDelimited<T>(
  columns: readonly TabularColumn<T>[],
  rows: readonly T[],
  delimiter: string,
): string {
  const header = columns.map((c) => delimitedCell(c.header, delimiter)).join(delimiter);
  const body = rows.map((row) => columns.map((c) => delimitedCell(c.value(row), delimiter)).join(delimiter));
  return [header, ...body].join('\r\n');
}

/** Spreadsheet-friendly CSV (RFC-4180 quoting, CRLF rows). */
export function toCsv<T>(columns: readonly TabularColumn<T>[], rows: readonly T[]): string {
  return toDelimited(columns, rows, ',');
}

/**
 * Tab-separated values (same RFC-4180 quoting, CRLF rows).
 *
 * @internal Exported for unit tests only.
 */
export function toTsv<T>(columns: readonly TabularColumn<T>[], rows: readonly T[]): string {
  return toDelimited(columns, rows, '\t');
}

/**
 * Serialise rows to a pretty-printed JSON array — one object per row keyed by column
 * header, with the raw cell values preserved (numbers stay numbers — minus their binary-float
 * noise — booleans stay booleans, null / undefined become `null`) so the file is faithful
 * and machine-readable.
 *
 * @internal Exported for unit tests only.
 */
export function toJson<T>(columns: readonly TabularColumn<T>[], rows: readonly T[]): string {
  const objects = rows.map((row) => {
    const object: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      const value = column.value(row);
      object[column.header] =
        typeof value === 'number' ? stripFloatNoise(value) : value === undefined ? null : value;
    }
    return object;
  });
  return JSON.stringify(objects, null, 2) + '\n';
}

/** Flatten any newline in a cell to a single space so a plain-text row stays on one line. */
function singleLine(value: TabularCell): string {
  return cellText(value).replace(/\r?\n/g, ' ');
}

/**
 * Serialise rows to a fixed-width plain-text table: each column padded to the widest of its
 * header and values, a dashed divider under the header, two spaces between columns. Useful
 * for pasting into a monospaced context (a README, a terminal, a note).
 *
 * @internal Exported for unit tests only.
 */
export function toTextTable<T>(columns: readonly TabularColumn<T>[], rows: readonly T[]): string {
  const headers = columns.map((c) => c.header);
  const body = rows.map((row) => columns.map((c) => singleLine(c.value(row))));
  // Fold each column's width rather than spreading every row into Math.max — a large list
  // would otherwise blow the argument limit / call stack.
  const widths = headers.map((header, i) =>
    body.reduce((max, cells) => Math.max(max, cells[i]!.length), header.length),
  );
  const format = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join('  ')
      .replace(/\s+$/, '');
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [format(headers), divider, ...body.map(format)].join('\n') + '\n';
}

/** Escape a Markdown-table cell: neutralise the pipe delimiter and collapse newlines. */
function markdownCell(value: TabularCell): string {
  // Escape the backslash first so a value containing one can't defeat the pipe escaping,
  // then neutralise the pipe (the column delimiter) and flatten any newline that would
  // otherwise break the single-row layout.
  return cellText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Build a GitHub-flavoured Markdown table (leading/trailing pipes, `---` divider row).
 *
 * @internal Exported for unit tests only.
 */
export function toMarkdownTable<T>(columns: readonly TabularColumn<T>[], rows: readonly T[]): string {
  const header = `| ${columns.map((c) => markdownCell(c.header)).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => markdownCell(c.value(row))).join(' | ')} |`);
  return [header, divider, ...body].join('\n') + '\n';
}

/** Escape a value for text content or an attribute inside the HTML document. */
function htmlEscape(value: TabularCell): string {
  return cellText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface HtmlTableOptions {
  /** Document `<title>` and page heading. Defaults to `Export`. */
  readonly title?: string;
  /** Optional sub-heading rendered under the title. */
  readonly caption?: string;
}

/**
 * Build a self-contained, printable HTML **document** (not a bare fragment) so the file
 * opens and prints straight from the browser. Styling is inline and deliberately minimal
 * — this is downloaded output, not app chrome, so it uses system fonts and neutral rules
 * rather than the app's design tokens. The neutral palette follows the reader's OS scheme
 * on screen but is pinned to black-on-white for print, matching the other printable
 * surfaces (labels, catalogue, schedule).
 *
 * @internal Exported for unit tests only.
 */
export function toHtmlTable<T>(
  columns: readonly TabularColumn<T>[],
  rows: readonly T[],
  options: HtmlTableOptions = {},
): string {
  const title = options.title ?? 'Export';
  const head = columns.map((c) => `<th>${htmlEscape(c.header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${htmlEscape(c.value(row))}</td>`).join('')}</tr>`)
    .join('\n      ');
  const caption = options.caption ? `\n    <p class="caption">${htmlEscape(options.caption)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    :root { color-scheme: light dark; --page: #fff; --ink: #111; --muted: #666; --rule: #ccc; --head: #f2f2f2; --zebra: #fafafa; }
    @media (prefers-color-scheme: dark) {
      :root { --page: #1c1c1e; --ink: #f2f2f2; --muted: #a1a1a1; --rule: #4a4a4d; --head: #2c2c2e; --zebra: #242426; }
    }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; line-height: 1.4; color: var(--ink); background: var(--page); }
    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    .caption { margin: 0 0 1rem; color: var(--muted); }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    th, td { border: 1px solid var(--rule); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
    thead th { background: var(--head); }
    tbody tr:nth-child(even) { background: var(--zebra); }
    /* Paper is a fixed, theme-less medium: pin the palette back to black ink on white
       regardless of the reader's OS scheme (issue #335). Browsers drop backgrounds when
       printing, so a dark-scheme page would otherwise print near-white text onto white
       paper. Declared last so it beats the dark block above at equal specificity, whether
       or not the print job still reports a dark colour-scheme preference. */
    @media print {
      :root { color-scheme: light; --page: #fff; --ink: #000; --muted: #555; --rule: #ccc; --head: #eee; --zebra: #fafafa; }
      body { margin: 0; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${htmlEscape(title)}</h1>${caption}
    <table>
      <thead>
        <tr>${head}</tr>
      </thead>
      <tbody>
      ${body}
      </tbody>
    </table>
  </main>
</body>
</html>
`;
}

/**
 * The file formats the tabular serialisers can produce for a downloadable export. The
 * lightweight text formats are serialised inline; `xlsx` is produced by a lazily-imported
 * module (see {@link buildTabularExport}) so its zip / OOXML weight never enters the eager
 * bundle.
 */
export type TabularExportFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'html' | 'txt' | 'xlsx';

export interface TabularExportResult {
  /** The serialised file — a string for the text formats, bytes for the binary XLSX. */
  readonly content: string | Uint8Array;
  /** MIME type for the download `Blob`. */
  readonly mimeType: string;
  /** File-name extension (no dot). */
  readonly extension: string;
  /**
   * A caveat about the file that must reach the user, appended to the success toast — in
   * practice, "this list was too long to read in full, so the file stops short" (the
   * `readAllPages` ceiling). The document `caption` can only say so in the formats that have
   * one (HTML, plain text), and CSV — the most-used format of the set — has nowhere to put it,
   * so the toast is the one channel every format shares. Omitted when the export is complete,
   * which is the overwhelmingly common case.
   */
  readonly notice?: string;
}

export interface TabularDocumentMeta {
  /** Heading for the Markdown document and `<title>` / `<h1>` of the HTML document. */
  readonly title: string;
  /** Optional sub-heading for the HTML document (e.g. a row count). */
  readonly caption?: string;
}

/** Frame a plain-text document with a title heading (and optional caption) above its body. */
function textDocument(meta: TabularDocumentMeta, body: string): string {
  const heading = `${meta.title}\n${'='.repeat(meta.title.length)}\n`;
  const caption = meta.caption ? `${meta.caption}\n` : '';
  return `${heading}${caption}\n${body}`;
}

/**
 * Serialise a table to the chosen format, returning the file content alongside the MIME
 * type and extension a download needs. The single place the formats are dispatched — every
 * "list → a file" export (project BOM, reorder shopping list, …) routes through here so the
 * format set, MIME types and document framing stay consistent.
 *
 * Async because the binary `xlsx` format is produced by a lazily-imported module (its zip /
 * OOXML machinery is only pulled in — and, in an installed PWA, cached — the first time a
 * spreadsheet is actually exported); the text formats resolve immediately.
 */
export async function buildTabularExport<T>(
  format: TabularExportFormat,
  columns: readonly TabularColumn<T>[],
  rows: readonly T[],
  meta: TabularDocumentMeta,
): Promise<TabularExportResult> {
  switch (format) {
    case 'csv':
      return { content: toCsv(columns, rows), mimeType: 'text/csv;charset=utf-8', extension: 'csv' };
    case 'tsv':
      return {
        content: toTsv(columns, rows),
        mimeType: 'text/tab-separated-values;charset=utf-8',
        extension: 'tsv',
      };
    case 'json':
      return {
        content: toJson(columns, rows),
        mimeType: 'application/json;charset=utf-8',
        extension: 'json',
      };
    case 'markdown':
      return {
        content: `# ${meta.title}\n\n${toMarkdownTable(columns, rows)}`,
        mimeType: 'text/markdown;charset=utf-8',
        extension: 'md',
      };
    case 'html':
      return {
        content: toHtmlTable(columns, rows, { title: meta.title, caption: meta.caption }),
        mimeType: 'text/html;charset=utf-8',
        extension: 'html',
      };
    case 'txt':
      return {
        content: textDocument(meta, toTextTable(columns, rows)),
        mimeType: 'text/plain;charset=utf-8',
        extension: 'txt',
      };
    case 'xlsx': {
      const { toXlsx } = await import('./xlsx-export');
      return {
        content: toXlsx(columns, rows, meta),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
    }
  }
}
