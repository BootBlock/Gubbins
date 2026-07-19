/**
 * XLSX (Office Open XML SpreadsheetML) serialiser for the shared tabular export seam
 * (issue #29). Kept in its own module so `buildTabularExport` can `import()` it on demand —
 * the zip machinery (`fflate`) and the OOXML boilerplate here only load the first time a
 * spreadsheet is actually exported, and in an installed PWA that chunk is then cached for
 * offline reuse rather than weighing down the eager bundle.
 *
 * A workbook is a zip of a handful of XML parts. We write one worksheet using **inline
 * strings** (no shared-string table) so the whole thing stays a pure, dependency-light
 * function: one column model in → one `.xlsx` byte array out, with numbers and booleans
 * preserved as native cell types so a spreadsheet treats them as such. Pure (no DOM).
 */
import { strToU8, zipSync } from 'fflate';
import { stripFloatNoise } from '@/lib/float-noise';
import type { TabularCell, TabularColumn, TabularDocumentMeta } from './tabular-export';

/** Escape a value for XML text content or a double-quoted attribute. */
function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The A1-style column letter for a zero-based column index (0 → A, 26 → AA). */
function columnLetter(index: number): string {
  let letter = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
  }
  return letter;
}

/** Serialise one cell to its `<c>` element, choosing the native type for the value. */
function cellXml(value: TabularCell, reference: string): string {
  if (value === null || value === undefined || value === '') return `<c r="${reference}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Written as the shortest round-tripping decimal, minus binary-float noise, so the
    // cell a spreadsheet shows matches the figure the app shows (issue #291).
    return `<c r="${reference}"><v>${stripFloatNoise(value)}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = xmlEscape(String(value));
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/** Serialise one worksheet row (`values` are already header/cell in column order). */
function rowXml(values: readonly TabularCell[], rowNumber: number): string {
  const cells = values.map((value, i) => cellXml(value, `${columnLetter(i)}${rowNumber}`)).join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

/**
 * A spreadsheet sheet name is capped at 31 characters and may not contain `\ / ? * [ ] :`.
 * Fall back to a neutral name when the title sanitises away to nothing.
 */
function sheetName(title: string): string {
  const cleaned = title
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || 'Sheet1';
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function workbookXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function worksheetXml(rows: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${rows.join('\n    ')}
  </sheetData>
</worksheet>`;
}

/**
 * Serialise the column model and rows to a `.xlsx` workbook (one worksheet, a bold-free
 * header row followed by the data). Returns the zipped OOXML package as bytes ready to drop
 * into a download `Blob`.
 */
export function toXlsx<T>(
  columns: readonly TabularColumn<T>[],
  rows: readonly T[],
  meta: TabularDocumentMeta,
): Uint8Array {
  const header = rowXml(
    columns.map((c) => c.header),
    1,
  );
  const body = rows.map((row, i) =>
    rowXml(
      columns.map((c) => c.value(row)),
      i + 2,
    ),
  );

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'xl/workbook.xml': strToU8(workbookXml(sheetName(meta.title))),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': strToU8(worksheetXml([header, ...body])),
  });
}
