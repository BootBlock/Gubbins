/**
 * Header inspection — the cheap gate that stops a truncated database overwriting a good one
 * (issue #198). The magic string alone passes every one of the "damaged" cases below, which
 * is precisely why the restore paths needed more than it.
 */
import { describe, it, expect } from 'vitest';
import { inspectSqliteHeader, isSqliteFile, SQLITE_MAGIC } from './sqlite-header';

const PAGE_SIZE = 4096;

/**
 * Build a byte-perfect (if empty) SQLite header. `pages` is what the header *claims*; the
 * returned file is that many pages long unless a test truncates it.
 */
function sqliteFile(options: { pages?: number; pageSize?: number } = {}): Uint8Array {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const pages = options.pages ?? 2;
  const bytes = new Uint8Array(pages * pageSize);
  bytes.set(
    Uint8Array.from(SQLITE_MAGIC, (c) => c.charCodeAt(0)),
    0,
  );
  // Page size (big-endian u16; 1 encodes the maximum 65536).
  const encoded = pageSize === 65536 ? 1 : pageSize;
  bytes[16] = (encoded >> 8) & 0xff;
  bytes[17] = encoded & 0xff;
  bytes[18] = 1; // write format version (legacy journal)
  bytes[19] = 1; // read format version
  bytes[20] = 0; // reserved space per page
  writeU32(bytes, 24, 7); // change counter
  writeU32(bytes, 28, pages); // database size in pages
  writeU32(bytes, 92, 7); // version-valid-for — matches, so the page count is authoritative
  return bytes;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

describe('inspectSqliteHeader', () => {
  it('accepts a well-formed database file', () => {
    const report = inspectSqliteHeader(sqliteFile({ pages: 4 }));
    expect(report).toMatchObject({ isSqlite: true, ok: true, pageSize: PAGE_SIZE, problems: [] });
  });

  it('accepts the 65536-byte maximum page size, which the header encodes as 1', () => {
    const report = inspectSqliteHeader(sqliteFile({ pages: 1, pageSize: 65536 }));
    expect(report.ok).toBe(true);
    expect(report.pageSize).toBe(65536);
  });

  it('rejects a file that is not a SQLite database at all', () => {
    const json = new TextEncoder().encode('{"formatVersion":1}');
    const report = inspectSqliteHeader(json);
    expect(report.isSqlite).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('rejects a file too short to hold the 100-byte header', () => {
    const bytes = sqliteFile().slice(0, 64);
    expect(inspectSqliteHeader(bytes).ok).toBe(false);
  });

  it('catches a download cut off mid-page — the case the magic check waves through', () => {
    const truncated = sqliteFile({ pages: 4 }).slice(0, 3 * PAGE_SIZE + 17);
    const report = inspectSqliteHeader(truncated);

    // The bytes that matter to the old guard are all still present and correct.
    expect(isSqliteFile(truncated)).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('truncated');
  });

  it('catches a file cut off on a page boundary, using the header’s own page count', () => {
    // A whole number of pages, so the arithmetic check alone would pass — only the declared
    // page count reveals that the last two pages never arrived.
    const short = sqliteFile({ pages: 6 }).slice(0, 4 * PAGE_SIZE);
    const report = inspectSqliteHeader(short);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('incomplete');
  });

  it('trusts the file length when the header’s page count is stale', () => {
    // A legacy writer left version-valid-for disagreeing with the change counter, so the
    // declared page count means nothing and must not be reported as damage.
    const bytes = sqliteFile({ pages: 4 });
    writeU32(bytes, 92, 3); // no longer matches the change counter at offset 24
    writeU32(bytes, 28, 99); // stale, wildly wrong page count
    expect(inspectSqliteHeader(bytes).ok).toBe(true);
  });

  it('rejects a page size that is not a power of two', () => {
    const bytes = sqliteFile();
    bytes[16] = 0x0f;
    bytes[17] = 0xa0; // 4000 — in range, but not a power of two
    const report = inspectSqliteHeader(bytes);
    expect(report.ok).toBe(false);
    expect(report.pageSize).toBeNull();
  });

  it('rejects format versions SQLite never writes', () => {
    const bytes = sqliteFile();
    bytes[18] = 9;
    expect(inspectSqliteHeader(bytes).ok).toBe(false);
  });

  it('rejects reserved space that no page could hold', () => {
    const bytes = sqliteFile();
    bytes[20] = 250; // leaves under the 480-byte minimum usable remainder... on a small page
    bytes[16] = 0x02;
    bytes[17] = 0x00; // 512-byte pages
    expect(inspectSqliteHeader(bytes).ok).toBe(false);
  });
});

describe('isSqliteFile (§3 raw restore guard)', () => {
  it('accepts a buffer beginning with the SQLite 3 magic header', () => {
    expect(isSqliteFile(sqliteFile())).toBe(true);
  });

  it('rejects a JSON file (wrong header)', () => {
    expect(isSqliteFile(new TextEncoder().encode('{"formatVersion":1}'))).toBe(false);
  });

  it('rejects a buffer shorter than the magic string', () => {
    expect(isSqliteFile(new Uint8Array([0x53, 0x51, 0x4c]))).toBe(false);
  });
});
