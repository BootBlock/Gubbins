import { describe, it, expect } from 'vitest';
import { isSqliteFile } from './safe-mode-actions';

/** The 16-byte SQLite 3 magic header as bytes. */
function sqliteHeader(): Uint8Array {
  const magic = 'SQLite format 3\0';
  return Uint8Array.from(magic, (c) => c.charCodeAt(0));
}

describe('isSqliteFile (§3 raw restore guard, Phase 14)', () => {
  it('accepts a buffer beginning with the SQLite 3 magic header', () => {
    const bytes = new Uint8Array(200);
    bytes.set(sqliteHeader(), 0);
    expect(isSqliteFile(bytes)).toBe(true);
  });

  it('rejects a JSON file (wrong header)', () => {
    const json = new TextEncoder().encode('{"formatVersion":1}');
    expect(isSqliteFile(json)).toBe(false);
  });

  it('rejects a truncated file shorter than the header', () => {
    expect(isSqliteFile(new Uint8Array([0x53, 0x51, 0x4c]))).toBe(false);
  });
});
