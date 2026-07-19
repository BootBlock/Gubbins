import { describe, it, expect } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  buildTabularExport,
  toCsv,
  toDelimited,
  toHtmlTable,
  toJson,
  toMarkdownTable,
  toTextTable,
  toTsv,
  type TabularColumn,
  type TabularExportFormat,
} from './tabular-export';

interface Row {
  readonly a: string;
  readonly b: number | null;
}

const columns: readonly TabularColumn<Row>[] = [
  { header: 'A', value: (r) => r.a },
  { header: 'B', value: (r) => r.b },
];

const rows: readonly Row[] = [
  { a: 'plain', b: 1 },
  { a: 'has, comma', b: null },
];

/** A single numeric column carrying a value with binary-float noise (issue #291). */
const NOISY_COLUMNS: readonly TabularColumn<{ readonly v: number }>[] = [
  { header: 'Value', value: (r) => r.v },
];
const NOISY_ROWS: readonly { readonly v: number }[] = [{ v: 0.1 + 0.2 }];

describe('toCsv / toDelimited', () => {
  it('joins headers and rows with CRLF and RFC-4180 quoting', () => {
    const csv = toCsv(columns, rows);
    const parts = csv.split('\r\n');
    expect(parts[0]).toBe('A,B');
    expect(parts[1]).toBe('plain,1');
    // A comma-bearing cell is quoted; a null cell is blank.
    expect(parts[2]).toBe('"has, comma",');
  });

  it('doubles inner quotes and quotes newline-bearing cells', () => {
    const csv = toCsv(
      [{ header: 'x', value: (r: { x: string }) => r.x }],
      [{ x: 'a "quote"' }, { x: 'line\nbreak' }],
    );
    const [, quoted, broken] = csv.split('\r\n');
    expect(quoted).toBe('"a ""quote"""');
    expect(broken).toBe('"line\nbreak"');
  });

  it('produces a header-only table for no rows', () => {
    expect(toCsv(columns, [])).toBe('A,B');
  });

  it('toTsv uses a tab delimiter and only quotes cells containing a tab', () => {
    const tsv = toTsv(
      [{ header: 'x', value: (r: { x: string }) => r.x }],
      [{ x: 'has, comma' }, { x: 'has\ttab' }],
    );
    const [header, comma, tab] = tsv.split('\r\n');
    expect(header).toBe('x');
    // A comma is not the TSV delimiter, so it stays unquoted.
    expect(comma).toBe('has, comma');
    expect(tab).toBe('"has\ttab"');
  });

  it('toDelimited is the shared engine behind CSV/TSV', () => {
    expect(toDelimited(columns, rows, ',')).toBe(toCsv(columns, rows));
    expect(toDelimited(columns, rows, '\t')).toBe(toTsv(columns, rows));
  });
});

describe('toJson', () => {
  it('emits one object per row keyed by header, preserving value types', () => {
    const json = toJson(columns, rows);
    expect(JSON.parse(json)).toEqual([
      { A: 'plain', B: 1 },
      { A: 'has, comma', B: null },
    ]);
  });

  it('is a pretty-printed array with a trailing newline', () => {
    const json = toJson(columns, rows);
    expect(json.endsWith('\n')).toBe(true);
    expect(json).toContain('\n  {');
  });
});

describe('toTextTable', () => {
  it('pads each column to the widest of its header and values with a dashed divider', () => {
    const txt = toTextTable(columns, rows);
    const linesOut = txt.trimEnd().split('\n');
    // Column A is widened to "has, comma" (10 chars), B to its 1-char header.
    expect(linesOut[0]).toMatch(/^A +B$/);
    expect(linesOut[1]).toBe('----------  -');
    expect(linesOut[2]).toMatch(/^plain +1$/);
    // A blank (null) cell leaves nothing after the value, so trailing padding is trimmed.
    expect(linesOut[3]).toBe('has, comma');
  });

  it('flattens newlines so a multi-line cell stays on one row', () => {
    const txt = toTextTable([{ header: 'x', value: (r: { x: string }) => r.x }], [{ x: 'a\nb' }]);
    expect(txt.trimEnd().split('\n')).toEqual(['x', '---', 'a b']);
  });
});

describe('toMarkdownTable', () => {
  it('emits a GFM table with a divider row and escapes pipes', () => {
    const md = toMarkdownTable([{ header: 'x', value: (r: { x: string }) => r.x }], [{ x: 'a|b' }]);
    const linesOut = md.trimEnd().split('\n');
    expect(linesOut[0]).toBe('| x |');
    expect(linesOut[1]).toBe('| --- |');
    expect(linesOut[2]).toBe('| a\\|b |');
  });

  it('flattens newlines and escapes backslashes before pipes', () => {
    const md = toMarkdownTable([{ header: 'x', value: (r: { x: string }) => r.x }], [{ x: 'a\\|b\nc' }]);
    // Backslash doubled, then the pipe escaped, then the newline flattened to a space.
    expect(md).toContain('| a\\\\\\|b c |');
  });
});

describe('toHtmlTable', () => {
  it('produces a standalone document with an escaped title and cells', () => {
    const html = toHtmlTable(
      [{ header: 'Name', value: (r: { name: string }) => r.name }],
      [{ name: '<script>' }],
      { title: 'A & B', caption: '1 line' },
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>A &amp; B</title>');
    expect(html).toContain('<h1>A &amp; B</h1>');
    expect(html).toContain('<p class="caption">1 line</p>');
    expect(html).toContain('<th>Name</th>');
    // The dangerous cell is escaped, not rendered as a tag.
    expect(html).toContain('<td>&lt;script&gt;</td>');
    expect(html).not.toContain('<script>');
  });

  it('defaults the title and omits the caption when not given', () => {
    const html = toHtmlTable(columns, rows);
    expect(html).toContain('<title>Export</title>');
    expect(html).not.toContain('class="caption"');
  });
});

describe('buildTabularExport', () => {
  const meta = { title: 'My list', caption: '2 rows' };

  it('returns the right content, MIME type and extension per format', async () => {
    const cases: Record<TabularExportFormat, { mime: string; ext: string }> = {
      csv: { mime: 'text/csv', ext: 'csv' },
      tsv: { mime: 'text/tab-separated-values', ext: 'tsv' },
      json: { mime: 'application/json', ext: 'json' },
      markdown: { mime: 'text/markdown', ext: 'md' },
      html: { mime: 'text/html', ext: 'html' },
      txt: { mime: 'text/plain', ext: 'txt' },
      xlsx: { mime: 'spreadsheetml.sheet', ext: 'xlsx' },
    };
    for (const [format, expected] of Object.entries(cases) as [
      TabularExportFormat,
      { mime: string; ext: string },
    ][]) {
      const result = await buildTabularExport(format, columns, rows, meta);
      expect(result.mimeType).toContain(expected.mime);
      expect(result.extension).toBe(expected.ext);
      expect(result.content.length).toBeGreaterThan(0);
    }
  });

  it('frames the Markdown document with the title heading and the delimited body matches toCsv', async () => {
    expect((await buildTabularExport('markdown', columns, rows, meta)).content).toContain('# My list\n\n');
    expect((await buildTabularExport('csv', columns, rows, meta)).content).toBe(toCsv(columns, rows));
  });

  it('frames the plain-text document with a title heading above the aligned table', async () => {
    const txt = (await buildTabularExport('txt', columns, rows, meta)).content as string;
    expect(txt).toContain('My list\n=======\n');
    expect(txt).toContain('2 rows');
    expect(txt).toContain(toTextTable(columns, rows));
  });

  it('serialises JSON that round-trips the rows', async () => {
    const json = (await buildTabularExport('json', columns, rows, meta)).content as string;
    expect(JSON.parse(json)).toHaveLength(2);
  });

  it('passes the title and caption into the HTML document', async () => {
    const html = (await buildTabularExport('html', columns, rows, meta)).content;
    expect(html).toContain('<title>My list</title>');
    expect(html).toContain('<p class="caption">2 rows</p>');
  });

  it('strips binary-float noise from numeric cells in every format (issue #291)', async () => {
    for (const format of ['csv', 'tsv', 'markdown', 'html', 'txt', 'json'] as const) {
      const content = (await buildTabularExport(format, NOISY_COLUMNS, NOISY_ROWS, meta)).content as string;
      // Match the whole numeric run so a merely-shorter artefact (0.29999999999999) fails too.
      expect(content).toMatch(/(^|[^\d.])0\.3([^\d]|$)/);
    }
    const json = (await buildTabularExport('json', NOISY_COLUMNS, NOISY_ROWS, meta)).content as string;
    expect((JSON.parse(json) as { Value: number }[])[0]!.Value).toBe(0.3);
  });

  it('produces a non-empty XLSX byte array (a PK zip) via the lazy module', async () => {
    const result = await buildTabularExport('xlsx', columns, rows, meta);
    expect(result.content).toBeInstanceOf(Uint8Array);
    const bytes = result.content as Uint8Array;
    // Every zip (and therefore every .xlsx) starts with the local-file-header magic "PK\x03\x04".
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('writes XLSX numeric cells without binary-float noise (issue #291)', async () => {
    const result = await buildTabularExport('xlsx', NOISY_COLUMNS, NOISY_ROWS, meta);
    const sheet = strFromU8(unzipSync(result.content as Uint8Array)['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<v>0.3</v>');
    expect(sheet).not.toContain('0.30000000000000004');
  });
});
