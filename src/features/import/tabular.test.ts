import { describe, it, expect } from 'vitest';
import {
  detectImportFormat,
  extractTableRows,
  isDelimitedFormat,
  isTabularFormat,
  parseCsv,
  parseDelimited,
  parseHtmlRows,
  parseJsonRows,
  parseMarkdownRows,
  readDelimited,
  IMPORT_FORMATS,
  UNTERMINATED_QUOTE_NOTE,
} from './tabular';

describe('parseDelimited / parseCsv (RFC-4180-ish codec)', () => {
  it('splits a simple CSV matrix', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('honours quoted fields with embedded delimiters and escaped quotes', () => {
    expect(parseCsv('"R1, R2",10k,3')).toEqual([['R1, R2', '10k', '3']]);
    expect(parseCsv('"a ""b"" c",d')).toEqual([['a "b" c', 'd']]);
  });

  it('parses tab-separated input via a custom delimiter', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('treats a quote inside an unquoted field as literal data (issue #591)', () => {
    // An inch mark is ordinary hardware-inventory text. Opening a quoted field on it
    // swallowed every later line — delimiters, newlines and all — into one cell.
    expect(parseCsv('name,quantity,location\n3/4" ball valve,5,Workshop\nWidget,2,Shed')).toEqual([
      ['name', 'quantity', 'location'],
      ['3/4" ball valve', '5', 'Workshop'],
      ['Widget', '2', 'Shed'],
    ]);
  });

  it('keeps a quote that follows other text in the same field', () => {
    expect(parseCsv('a,1/4" drive,b')).toEqual([['a', '1/4" drive', 'b']]);
    // A quote is structural only at the start of a field, so a quoted cell still parses.
    expect(parseCsv('"a,b",1/2" pipe')).toEqual([['a,b', '1/2" pipe']]);
  });

  it('reports whether the text ended inside a quoted field', () => {
    expect(readDelimited('a,b\n1,2').unterminatedQuote).toBe(false);
    expect(readDelimited('"a,b",c').unterminatedQuote).toBe(false);
    expect(readDelimited('a,b\n"never closed,2').unterminatedQuote).toBe(true);
  });
});

describe('format helpers', () => {
  it('classifies delimited and tabular formats', () => {
    expect(isDelimitedFormat('csv')).toBe(true);
    expect(isDelimitedFormat('json')).toBe(false);
    expect(isTabularFormat('lines')).toBe(false);
    expect(isTabularFormat('html')).toBe(true);
    expect(IMPORT_FORMATS).toContain('html');
  });
});

describe('detectImportFormat', () => {
  it('detects JSON', () => {
    expect(detectImportFormat('[{"a":1}]')).toBe('json');
  });
  it('detects an HTML table before falling through to a delimiter', () => {
    expect(detectImportFormat('<table><tr><td>a</td><td>b</td></tr></table>')).toBe('html');
  });
  it('detects a Markdown table', () => {
    expect(detectImportFormat('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('markdown');
  });
  it('detects TSV / CSV by consistent columns', () => {
    expect(detectImportFormat('a\tb\n1\t2')).toBe('tsv');
    expect(detectImportFormat('a,b\n1,2')).toBe('csv');
  });
  it('falls back to a line list when nothing is tabular', () => {
    expect(detectImportFormat('just some free text\nanother line')).toBe('lines');
  });
  it('is not fooled by a delimiter inside a quoted cell', () => {
    // The naive sniff counted the comma in "1,234.56" as a column break and gave up on a
    // perfectly good CSV; the codec-backed sniff reads the quoting properly.
    expect(detectImportFormat('Name,Price\nWidget,"£1,234.56"')).toBe('csv');
    expect(detectImportFormat('Reference,Value\n"R1, R2",10k')).toBe('csv');
  });
  it('still detects CSV when a stray quote is left open (issue #591)', () => {
    // Before, the merged remainder made no delimiter look consistent and detection fell
    // through to 'lines' — which offered each merged line as an item, with no warning.
    expect(detectImportFormat('name,quantity\n"broken,5\nWidget,2')).toBe('csv');
  });

  it('still reads a single free-form line with a stray quote as a line list', () => {
    // One line carrying an unmatched quote is a note, not a table; only a multi-line block
    // earns the quote-blind re-measure above.
    expect(detectImportFormat('"he said hi, there')).toBe('lines');
  });

  it('detects CSV for a file full of inch marks', () => {
    expect(detectImportFormat('name,quantity\n3/4" ball valve,5\n12" ruler,1')).toBe('csv');
  });

  it('ignores a final row severed by the detection sample window', () => {
    // 12 rows: the 10-line sample cuts mid-file, leaving a partial last row that proves nothing.
    const rows = Array.from({ length: 12 }, (_, i) => `item${i},${i}`).join('\n');
    expect(detectImportFormat(`Name,Qty\n${rows}`)).toBe('csv');
  });
});

describe('parseHtmlRows', () => {
  it('reads a th header + td rows, decoding entities and stripping tags', () => {
    const html =
      '<table><tr><th>Name</th><th>Qty</th></tr>' +
      '<tr><td><b>R&amp;D board</b></td><td>2</td></tr>' +
      '<tr><td>Fuse &lt;fast&gt;</td><td>10</td></tr></table>';
    expect(parseHtmlRows(html)).toEqual({
      headerRow: ['Name', 'Qty'],
      dataRows: [
        ['R&D board', '2'],
        ['Fuse <fast>', '10'],
      ],
    });
  });

  it('returns null when there is no table row', () => {
    expect(parseHtmlRows('<div>no table here</div>')).toBeNull();
  });

  it('ignores markup outside the first table', () => {
    const html = '<p>intro</p><table><tr><td>a</td><td>b</td></tr></table>';
    expect(parseHtmlRows(html)?.headerRow).toEqual(['a', 'b']);
  });

  it('fully strips nested/overlapping tags a single-pass regex would leave behind', () => {
    const html =
      '<table><tr><th>Name</th><th>Qty</th></tr>' +
      '<tr><td><scr<script>ipt>alert(1)</td><td>b</td></tr></table>';
    expect(parseHtmlRows(html)?.dataRows[0]?.[0]).not.toContain('<script');
  });
});

describe('parseJsonRows / parseMarkdownRows', () => {
  it('turns an array of objects into a header + rows', () => {
    expect(parseJsonRows('[{"name":"R1","qty":2}]')).toEqual({
      headerRow: ['name', 'qty'],
      dataRows: [['R1', '2']],
    });
  });
  it('parses a GitHub-flavoured Markdown table', () => {
    expect(parseMarkdownRows('| Name | Qty |\n| --- | --- |\n| R1 | 2 |')).toEqual({
      headerRow: ['Name', 'Qty'],
      dataRows: [['R1', '2']],
    });
  });
});

describe('extractTableRows', () => {
  it('extracts a delimited matrix and honours the header toggle', () => {
    const withHeader = extractTableRows('a,b\n1,2\n3,4');
    expect(withHeader.headerRow).toEqual(['a', 'b']);
    expect(withHeader.dataRows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);

    const headerless = extractTableRows('1,2\n3,4', { hasHeader: false });
    expect(headerless.headerRow).toEqual(['Column 1', 'Column 2']);
    expect(headerless.dataRows).toHaveLength(2);
  });

  it('extracts JSON, Markdown and HTML tables', () => {
    expect(extractTableRows('[{"name":"R1"}]').format).toBe('json');
    expect(extractTableRows('| a |\n| --- |\n| 1 |').format).toBe('markdown');
    const html = extractTableRows(
      '<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(html.format).toBe('html');
    expect(html.dataRows).toEqual([['1', '2']]);
  });

  it('refuses to extract rows from a file with an unclosed quote (issue #591)', () => {
    const extraction = extractTableRows('name,quantity\n"broken,5\nWidget,2', { format: 'csv' });
    expect(extraction.unterminatedQuote).toBe(true);
    expect(extraction.note).toBe(UNTERMINATED_QUOTE_NOTE);
    expect(extraction.dataRows).toEqual([]);
  });

  it('extracts an inch mark as part of the cell rather than merging the file', () => {
    const extraction = extractTableRows('name,quantity\n3/4" ball valve,5\nWidget,2');
    expect(extraction.format).toBe('csv');
    expect(extraction.unterminatedQuote).toBeUndefined();
    expect(extraction.dataRows).toEqual([
      ['3/4" ball valve', '5'],
      ['Widget', '2'],
    ]);
  });

  it('returns a note (not a throw) for malformed structured input', () => {
    expect(extractTableRows('{ not json', { format: 'json' }).note).toBeTruthy();
    expect(extractTableRows('<div/>', { format: 'html' }).note).toBeTruthy();
    expect(extractTableRows('free text', { format: 'lines' }).note).toBeTruthy();
  });
});
