import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_FILE_BYTES,
  decodeImportFileBytes,
  readImportFile,
  type BinaryFileKind,
  type ImportFileRead,
} from './file-source';

/** UTF-8 bytes for `text`. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Raw bytes, spelled out — for the binary and legacy-encoding cases. */
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

/** The text of a successful read, or a failing assertion naming the rejection instead. */
function textOf(read: ImportFileRead): string {
  if (!read.ok) throw new Error(`expected text, got rejection: ${JSON.stringify(read.rejection)}`);
  return read.text;
}

describe('decodeImportFileBytes', () => {
  it('reads plain UTF-8 as-is', () => {
    const read = decodeImportFileBytes(utf8('Name,Qty\nResistor 10k,50\n'));
    expect(read.ok && read.encoding).toBe('utf-8');
    expect(textOf(read)).toBe('Name,Qty\nResistor 10k,50\n');
  });

  it('strips a UTF-8 byte-order mark so the first header is not mis-read', () => {
    // A spreadsheet's "CSV UTF-8" export leads with EF BB BF; left in place it becomes an
    // invisible character on the first header cell, which then maps to no column.
    const read = decodeImportFileBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('Name,Qty\n')]));
    expect(read.ok && read.encoding).toBe('utf-8');
    expect(textOf(read)).toBe('Name,Qty\n');
  });

  it('reads UTF-16 by its byte-order mark rather than calling its NUL bytes binary', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x2c, 0x00, 0x42, 0x00]);
    expect(textOf(decodeImportFileBytes(le))).toBe('A,B');
    expect(decodeImportFileBytes(le).ok && decodeImportFileBytes(le).encoding).toBe('utf-16le');
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0x2c, 0x00, 0x42]);
    expect(textOf(decodeImportFileBytes(be))).toBe('A,B');
    expect(decodeImportFileBytes(be).ok && decodeImportFileBytes(be).encoding).toBe('utf-16be');
  });

  it('falls back to Windows-1252 for a Latin-1 export, and says that is what it did', () => {
    // The insidious case: this parses as a perfectly good table either way, so a lossy UTF-8
    // decode would corrupt only the accented characters — silently, cell by cell.
    const latin1 = bytes(0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a); // "Name\nCafé\n"
    const read = decodeImportFileBytes(latin1);
    expect(read.ok && read.encoding).toBe('windows-1252');
    expect(textOf(read)).toBe('Name\nCafé\n');
    expect(textOf(read)).not.toContain('�');
  });

  it('drops a UTF-8 mark even when the body forces the Windows-1252 fallback', () => {
    // Only the UTF-8 decoder strips a mark, so a marked file whose body is Latin-1 would otherwise
    // arrive with "ï»¿" welded to its first header cell — a column that then maps to nothing.
    const marked = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes(0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a), // "Name\nCafé\n"
    ]);
    const read = decodeImportFileBytes(marked);
    expect(read.ok && read.encoding).toBe('windows-1252');
    expect(textOf(read)).toBe('Name\nCafé\n');
  });

  it('keeps a short export carrying one legacy end-of-file marker', () => {
    // 0x1A is 5% of this file, so a bare control-character *share* would refuse it; a stray control
    // character must not cost the user their import.
    const dosCsv = new Uint8Array([...utf8('Name,Qty\nWidget,3\n'), 0x1a]);
    const read = decodeImportFileBytes(dosCsv);
    expect(read.ok).toBe(true);
    expect(textOf(read)).toContain('Widget,3');
  });

  it('prefers UTF-8 when the bytes are valid in it', () => {
    // "Café" in UTF-8 is also decodable as Windows-1252 (as "CafÃ©"), so order matters.
    const read = decodeImportFileBytes(utf8('Café'));
    expect(read.ok && read.encoding).toBe('utf-8');
    expect(textOf(read)).toBe('Café');
  });

  it.each<[string, Uint8Array, BinaryFileKind]>([
    ['a zip package (.xlsx / .ods / .docx)', bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06), 'package'],
    [
      'a legacy Office document (.xls / .doc)',
      bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00),
      'legacyOffice',
    ],
    ['a PDF', new Uint8Array([...utf8('%PDF-1.7'), 0x0a, 0x25]), 'pdf'],
    ['a PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00), 'image'],
    ['a JPEG photo', bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), 'image'],
    ['a HEIC photo / MP4 video', new Uint8Array([0x00, 0x00, 0x00, 0x18, ...utf8('ftypheic')]), 'image'],
    ['a gzip archive', bytes(0x1f, 0x8b, 0x08, 0x00, 0x01), 'archive'],
  ])('refuses %s by signature', (_label, input, kind) => {
    const read = decodeImportFileBytes(input);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.rejection).toEqual({ reason: 'binary', kind });
  });

  it('refuses an unrecognised binary file on its control bytes alone', () => {
    // No signature, but a NUL byte is proof: no encoding this accepts can produce one.
    const read = decodeImportFileBytes(bytes(0x4a, 0x4b, 0x00, 0x4c, 0x4d));
    expect(!read.ok && read.rejection).toEqual({ reason: 'binary', kind: 'unknown' });
  });

  it('still refuses a control-dense file that happens to hold no NUL byte', () => {
    const noisy = new Uint8Array([...utf8('Name'), 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, ...utf8('Qty')]);
    expect(!decodeImportFileBytes(noisy).ok).toBe(true);
  });

  it('refuses UTF-16-marked bytes that decode to control characters, not text', () => {
    // The byte-order mark buys the file past the NUL check, so the *decoded* text is what has to
    // hold up: a run of C1 control characters is not a parts list.
    const noise = new Uint8Array([
      0xff,
      0xfe,
      ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 0x00 : 0x01)),
    ]);
    const read = decodeImportFileBytes(noise);
    expect(!read.ok && read.rejection).toEqual({ reason: 'binary', kind: 'unknown' });
  });

  it('keeps a file whose only control characters are tabs and newlines', () => {
    const read = decodeImportFileBytes(utf8('Name\tQty\r\nResistor\t50\r\n\f'));
    expect(read.ok).toBe(true);
  });

  it('refuses an empty file, and one holding nothing but whitespace', () => {
    expect(decodeImportFileBytes(new Uint8Array())).toEqual({
      ok: false,
      rejection: { reason: 'empty' },
    });
    expect(decodeImportFileBytes(utf8('  \n\t\n'))).toEqual({
      ok: false,
      rejection: { reason: 'empty' },
    });
  });

  it('refuses bytes over the cap, reporting both figures', () => {
    const read = decodeImportFileBytes(utf8('abcdefghij'), 4);
    expect(!read.ok && read.rejection).toEqual({ reason: 'tooLarge', bytes: 10, limitBytes: 4 });
  });

  it('caps at 16 MB by default', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(16_000_000);
  });
});

describe('readImportFile', () => {
  it('reads a picked text file', async () => {
    const file = new File(['Name,Qty\nResistor,5\n'], 'items.csv', { type: 'text/csv' });
    const read = await readImportFile(file);
    expect(read.ok && read.encoding).toBe('utf-8');
    expect(textOf(read)).toBe('Name,Qty\nResistor,5\n');
  });

  it('refuses an oversized file from its size alone, without reading it', async () => {
    let readAttempts = 0;
    const file = new File(['x'.repeat(64)], 'huge.csv');
    // A real 100 MB pick must not be loaded into memory at all, so the guard has to sit in front
    // of the read rather than in front of the parse.
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        readAttempts += 1;
        return Promise.resolve(new ArrayBuffer(0));
      },
    });
    const read = await readImportFile(file, 32);
    expect(!read.ok && read.rejection).toEqual({ reason: 'tooLarge', bytes: 64, limitBytes: 32 });
    expect(readAttempts).toBe(0);
  });

  it('refuses a spreadsheet workbook the picker let through', async () => {
    // `accept` is advisory — the OS picker's "All files" defeats it — so the content decides.
    const file = new File([bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00)], 'stock.xlsx');
    const read = await readImportFile(file);
    expect(!read.ok && read.rejection).toEqual({ reason: 'binary', kind: 'package' });
  });

  it('reports an unreadable file rather than throwing at the call site', async () => {
    const file = new File(['data'], 'gone.csv');
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new Error('NotFoundError')),
    });
    await expect(readImportFile(file)).resolves.toEqual({
      ok: false,
      rejection: { reason: 'unreadable' },
    });
  });

  it('refuses an empty file', async () => {
    const read = await readImportFile(new File([], 'empty.csv'));
    expect(!read.ok && read.rejection).toEqual({ reason: 'empty' });
  });
});
