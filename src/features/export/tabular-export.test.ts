import { describe, it, expect } from 'vitest';
import {
  toCsv,
  toDelimited,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  type TabularColumn,
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
