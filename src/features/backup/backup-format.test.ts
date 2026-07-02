import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { SYNC_FORMAT_VERSION, type SyncSnapshot } from '../sync/types';
import type { SqlRow } from '@/db/rpc/driver';
import {
  assembleBackup,
  buildManifest,
  filterSnapshot,
  parseBackupEntries,
  readBackupFile,
  InvalidBackupError,
  DEFAULT_BACKUP_SELECTION,
  SNAPSHOT_ENTRY,
  MANIFEST_ENTRY,
  DATABASE_ENTRY,
  SETTINGS_ENTRY,
} from './backup-format';

const SQLITE_HEADER = new Uint8Array([...'SQLite format 3\0'].map((c) => c.charCodeAt(0)));
function fakeSqlite(): Uint8Array {
  return new Uint8Array([...SQLITE_HEADER, 1, 2, 3, 4]);
}

function item(id: string, isActive: number, parentId: string | null = null): SqlRow {
  return { id, name: id, is_active: isActive, parent_id: parentId } as unknown as SqlRow;
}

function makeSnapshot(): SyncSnapshot {
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    generatedAt: 1_000,
    tables: {
      items: [
        item('A', 1),
        item('B', 0), // removed
        item('C', 1, 'B'), // active variant of a removed parent → must drop (FK-safe)
        item('D', 1, 'A'), // active variant of a kept parent → keep
      ],
      item_images: [
        { id: 'img1', item_id: 'A' } as unknown as SqlRow,
        { id: 'img2', item_id: 'B' } as unknown as SqlRow,
      ],
      capabilities: [{ id: 'cap1', item_id: 'C' } as unknown as SqlRow],
      locations: [{ id: 'loc1', name: 'Bin' } as unknown as SqlRow], // no item_id → always kept
    },
    tombstones: [{ tableName: 'items', id: 'Z', deletedAt: 5 }],
    gaugeHistory: [
      { id: 'g1', itemId: 'A', netValueDelta: 1, createdAt: 1 },
      { id: 'g2', itemId: 'C', netValueDelta: 1, createdAt: 1 },
    ],
    itemTags: [
      { itemId: 'A', tagId: 't1' },
      { itemId: 'B', tagId: 't1' },
    ],
    itemHistory: [
      { id: 'h1', item_id: 'A' } as unknown as SqlRow,
      { id: 'h2', item_id: 'B' } as unknown as SqlRow,
    ],
  };
}

describe('filterSnapshot', () => {
  it('drops history when excluded but leaves everything else intact', () => {
    const out = filterSnapshot(makeSnapshot(), { includeHistory: false, includeRemovedItems: true });
    expect(out.itemHistory).toEqual([]);
    expect(out.gaugeHistory).toEqual([]);
    expect(out.tables.items).toHaveLength(4);
    expect(out.itemTags).toHaveLength(2);
  });

  it('drops removed items and every row that references them (FK-safe)', () => {
    const out = filterSnapshot(makeSnapshot(), { includeHistory: true, includeRemovedItems: false });

    const itemIds = (out.tables.items ?? []).map((r) => r.id);
    expect(itemIds).toEqual(['A', 'D']); // B removed; C dropped as a child of removed B

    expect((out.tables.item_images ?? []).map((r) => r.id)).toEqual(['img1']); // img2 (B) gone
    expect(out.tables.capabilities).toEqual([]); // cap1 (C) gone
    expect(out.tables.locations).toHaveLength(1); // unrelated table untouched

    expect((out.itemHistory ?? []).map((r) => r.id)).toEqual(['h1']);
    expect(out.itemTags).toEqual([{ itemId: 'A', tagId: 't1' }]);
    expect(out.gaugeHistory.map((d) => d.id)).toEqual(['g1']);

    // No surviving row references a dropped item — the result is import-safe.
    const surviving = new Set(itemIds.map(String));
    for (const rows of Object.values(out.tables)) {
      for (const row of rows) {
        if (row.item_id != null) expect(surviving.has(String(row.item_id))).toBe(true);
        if (row.parent_id != null) expect(surviving.has(String(row.parent_id))).toBe(true);
      }
    }
  });

  it('does not mutate the input snapshot', () => {
    const input = makeSnapshot();
    filterSnapshot(input, { includeHistory: false, includeRemovedItems: false });
    expect(input.tables.items).toHaveLength(4);
    expect(input.itemHistory).toHaveLength(2);
  });
});

describe('buildManifest', () => {
  it('reflects the selection and counts', () => {
    const manifest = buildManifest({
      snapshot: makeSnapshot(),
      selection: { ...DEFAULT_BACKUP_SELECTION, history: false },
      appVersion: '9.9.9',
      createdAt: 42,
      imageCount: 3,
      hasSqlite: true,
      hasSettings: false,
    });
    expect(manifest.kind).toBe('gubbins-backup');
    expect(manifest.appVersion).toBe('9.9.9');
    expect(manifest.createdAt).toBe(42);
    expect(manifest.contents).toMatchObject({
      rawSqlite: true,
      images: true,
      settings: false,
      history: false,
    });
    expect(manifest.counts).toEqual({ items: 4, images: 3 });
  });
});

describe('assembleBackup', () => {
  it('emits the right entries for a full backup', () => {
    const { files, assets, manifest } = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: fakeSqlite(),
      images: [{ name: 'a.webp', bytes: new Uint8Array([1]) }],
      settings: { 'gubbins:layout': '{}' },
      appVersion: '1.0.0',
      createdAt: 10,
    });
    expect(Object.keys(files).sort()).toEqual([MANIFEST_ENTRY, SETTINGS_ENTRY, SNAPSHOT_ENTRY].sort());
    expect(Object.keys(assets)).toEqual([DATABASE_ENTRY, 'images/a.webp']);
    expect(manifest.contents.rawSqlite).toBe(true);
  });

  it('omits optional entries when not provided', () => {
    const { files, assets } = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: null,
      images: [],
      settings: null,
      appVersion: '1.0.0',
      createdAt: 10,
    });
    expect(Object.keys(files).sort()).toEqual([MANIFEST_ENTRY, SNAPSHOT_ENTRY].sort());
    expect(Object.keys(assets)).toEqual([]);
  });
});

/** Encode an {@link assembleBackup} result into the `path → bytes` map the reader consumes. */
function toEntries(files: Record<string, string>, assets: Record<string, Uint8Array>) {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
  for (const [path, bytes] of Object.entries(assets)) entries[path] = bytes;
  return entries;
}

describe('parseBackupEntries', () => {
  it('round-trips an assembled backup', () => {
    const built = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: fakeSqlite(),
      images: [{ name: 'a.webp', bytes: new Uint8Array([9]) }],
      settings: { 'gubbins:layout': '{"state":{}}' },
      appVersion: '1.0.0',
      createdAt: 10,
    });
    const parsed = parseBackupEntries(toEntries(built.files, built.assets));
    expect(parsed.manifest?.kind).toBe('gubbins-backup');
    expect(parsed.snapshot.tables.items).toHaveLength(4);
    expect(parsed.sqlite).not.toBeNull();
    expect(parsed.images).toEqual([{ name: 'a.webp', bytes: new Uint8Array([9]) }]);
    expect(parsed.settings).toEqual({ 'gubbins:layout': '{"state":{}}' });
  });

  it('throws when the snapshot file is missing', () => {
    expect(() => parseBackupEntries({ [MANIFEST_ENTRY]: strToU8('{}') })).toThrow(InvalidBackupError);
  });

  it('throws when the embedded database is not a real SQLite file', () => {
    const built = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: null,
      images: [],
      settings: null,
      appVersion: '1.0.0',
      createdAt: 10,
    });
    const entries = toEntries(built.files, built.assets);
    entries[DATABASE_ENTRY] = new Uint8Array([0, 1, 2, 3]); // bogus header
    expect(() => parseBackupEntries(entries)).toThrow(/not a valid SQLite file/);
  });

  it('re-sanitises a hand-edited settings file on the way in', () => {
    const built = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: null,
      images: [],
      settings: null,
      appVersion: '1.0.0',
      createdAt: 10,
    });
    const entries = toEntries(built.files, built.assets);
    entries[SETTINGS_ENTRY] = strToU8(JSON.stringify({ 'gubbins:auth': 'sneaky', 'gubbins:layout': '{}' }));
    const parsed = parseBackupEntries(entries);
    expect(parsed.settings).toEqual({ 'gubbins:layout': '{}' }); // auth stripped
  });
});

describe('readBackupFile', () => {
  it('reads a real .zip backup', () => {
    const built = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: fakeSqlite(),
      images: [],
      settings: null,
      appVersion: '1.0.0',
      createdAt: 10,
    });
    const zip = zipSync(toEntries(built.files, built.assets));
    const parsed = readBackupFile(zip);
    expect(parsed.snapshot.tables.items).toHaveLength(4);
    expect(parsed.sqlite).not.toBeNull();
  });

  it('falls back to a bare-JSON snapshot (legacy backup)', () => {
    const bare = strToU8(JSON.stringify(makeSnapshot()));
    const parsed = readBackupFile(bare);
    expect(parsed.manifest).toBeNull();
    expect(parsed.snapshot.tables.items).toHaveLength(4);
    expect(parsed.sqlite).toBeNull();
  });

  it('rejects a file that is neither a zip nor a backup JSON', () => {
    expect(() => readBackupFile(strToU8('definitely not a backup'))).toThrow(InvalidBackupError);
  });
});
