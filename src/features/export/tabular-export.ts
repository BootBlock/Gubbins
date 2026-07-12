/**
 * Pure tabular serialisers shared by every "list → a file" export (issue #27).
 *
 * A single column model ({@link TabularColumn}) feeds four output formats — delimited
 * (CSV / TSV), a GitHub-flavoured Markdown table, and a self-contained printable HTML
 * document — so a new tabular export (the project BOM, the items CSV, …) declares its
 * columns once and gets every format for free, with the quoting / escaping written and
 * unit-tested in one place. Kept free of React, repositories and the DOM.
 */

/** A cell's raw value before serialisation; null / undefined render as an empty cell. */
export type TabularCell = string | number | boolean | null | undefined;

export interface TabularColumn<T> {
  /** The column heading (also escaped per the chosen format). */
  readonly header: string;
  /** Extract this column's value from a row. */
  readonly value: (row: T) => TabularCell;
}

/** Normalise a cell to its string form; null / undefined become an empty string. */
function cellText(value: TabularCell): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Quote a delimited-file cell per RFC-4180: wrap in double quotes (doubling any inner
 * quote) when it contains the delimiter, a quote, or a CR / LF. Shared by CSV (comma)
 * and TSV (tab) so a value carrying the delimiter round-trips intact.
 */
function delimitedCell(value: TabularCell, delimiter: string): string {
  const text = cellText(value);
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialise rows to a delimited table with CRLF row separators. `delimiter` is `,` for
 * CSV or a tab for TSV; both share the RFC-4180 quoting above.
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

/** Tab-separated values (same RFC-4180 quoting, CRLF rows). */
export function toTsv<T>(columns: readonly TabularColumn<T>[], rows: readonly T[]): string {
  return toDelimited(columns, rows, '\t');
}

/** Escape a Markdown-table cell: neutralise the pipe delimiter and collapse newlines. */
function markdownCell(value: TabularCell): string {
  // Escape the backslash first so a value containing one can't defeat the pipe escaping,
  // then neutralise the pipe (the column delimiter) and flatten any newline that would
  // otherwise break the single-row layout.
  return cellText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Build a GitHub-flavoured Markdown table (leading/trailing pipes, `---` divider row). */
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
 * rather than the app's design tokens.
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
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; line-height: 1.4; }
    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    .caption { margin: 0 0 1rem; color: #666; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
    thead th { background: #f2f2f2; }
    tbody tr:nth-child(even) { background: #fafafa; }
    @media print { body { margin: 0; } thead th { background: #eee; } }
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

/** The file formats the tabular serialisers can produce for a downloadable export. */
export type TabularExportFormat = 'csv' | 'tsv' | 'markdown' | 'html';

export interface TabularExportResult {
  readonly content: string;
  /** MIME type for the download `Blob`. */
  readonly mimeType: string;
  /** File-name extension (no dot). */
  readonly extension: string;
}

export interface TabularDocumentMeta {
  /** Heading for the Markdown document and `<title>` / `<h1>` of the HTML document. */
  readonly title: string;
  /** Optional sub-heading for the HTML document (e.g. a row count). */
  readonly caption?: string;
}

/**
 * Serialise a table to the chosen format, returning the file content alongside the MIME
 * type and extension a download needs. The single place the four formats are dispatched —
 * every "list → a file" export (project BOM, reorder shopping list, …) routes through here
 * so the format set, MIME types and document framing stay consistent.
 */
export function buildTabularExport<T>(
  format: TabularExportFormat,
  columns: readonly TabularColumn<T>[],
  rows: readonly T[],
  meta: TabularDocumentMeta,
): TabularExportResult {
  switch (format) {
    case 'csv':
      return { content: toCsv(columns, rows), mimeType: 'text/csv;charset=utf-8', extension: 'csv' };
    case 'tsv':
      return {
        content: toTsv(columns, rows),
        mimeType: 'text/tab-separated-values;charset=utf-8',
        extension: 'tsv',
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
  }
}
