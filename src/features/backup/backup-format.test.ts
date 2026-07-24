import { describe, it, expect } from 'vitest';
import { zipSync, strToU8, strFromU8 } from 'fflate';
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
  type BackupManifest,
} from './backup-format';
import { CHECKSUM_ALGORITHM, checksumBytes } from './checksum';

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
        item('E', 1, 'C'), // grandchild of removed B → must drop too (issue #152)
      ],
      item_images: [
        { id: 'img1', item_id: 'A' } as unknown as SqlRow,
        { id: 'img2', item_id: 'B' } as unknown as SqlRow,
      ],
      capabilities: [{ id: 'cap1', item_id: 'C' } as unknown as SqlRow],
      // Both endpoints are NOT NULL references to items under names other than `item_id`
      // (issue #152) — a relation touching a removed item must not survive.
      item_relations: [
        { id: 'A|D|works_with', from_item_id: 'A', to_item_id: 'D' } as unknown as SqlRow,
        { id: 'A|B|works_with', from_item_id: 'A', to_item_id: 'B' } as unknown as SqlRow,
        { id: 'E|A|works_with', from_item_id: 'E', to_item_id: 'A' } as unknown as SqlRow,
      ],
      // A nullable reference (ON DELETE SET NULL): the line is a record of money spent, so it
      // keeps its row and merely loses the link.
      purchase_order_lines: [{ id: 'pol1', po_id: 'po1', item_id: 'B', qty: 2 } as unknown as SqlRow],
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
    locationTags: [],
    itemRegions: [
      { itemId: 'A', regionId: 'r1' },
      { itemId: 'B', regionId: 'r1' },
    ],
    itemHistory: [
      { id: 'h1', item_id: 'A' } as unknown as SqlRow,
      { id: 'h2', item_id: 'B' } as unknown as SqlRow,
    ],
    stockDeltas: [
      { id: 's1', item_id: 'A' } as unknown as SqlRow,
      { id: 's2', item_id: 'B' } as unknown as SqlRow,
    ],
  };
}

describe('filterSnapshot', () => {
  it('drops history when excluded but leaves everything else intact', () => {
    const out = filterSnapshot(makeSnapshot(), { includeHistory: false, includeRemovedItems: true });
    expect(out.itemHistory).toEqual([]);
    expect(out.gaugeHistory).toEqual([]);
    expect(out.tables.items).toHaveLength(5);
    expect(out.itemTags).toHaveLength(2);
  });

  it('drops removed items and every row that references them (FK-safe)', () => {
    const out = filterSnapshot(makeSnapshot(), { includeHistory: true, includeRemovedItems: false });

    const itemIds = (out.tables.items ?? []).map((r) => r.id);
    // B removed; C dropped as its variant; E dropped as C's variant (transitive, issue #152).
    expect(itemIds).toEqual(['A', 'D']);

    expect((out.tables.item_images ?? []).map((r) => r.id)).toEqual(['img1']); // img2 (B) gone
    expect(out.tables.capabilities).toEqual([]); // cap1 (C) gone
    expect(out.tables.locations).toHaveLength(1); // unrelated table untouched

    // Only the relation between two surviving items is left: the NOT-NULL `from_item_id` /
    // `to_item_id` references would otherwise abort the whole restore (issue #152).
    expect((out.tables.item_relations ?? []).map((r) => r.id)).toEqual(['A|D|works_with']);

    expect((out.itemHistory ?? []).map((r) => r.id)).toEqual(['h1']);
    // The stock-delta ledger is FK-repaired against removed items exactly like item_history:
    // s2 (B, removed) is dropped, s1 (A) survives (issue #188).
    expect((out.stockDeltas ?? []).map((r) => r.id)).toEqual(['s1']);
    expect(out.itemTags).toEqual([{ itemId: 'A', tagId: 't1' }]);
    expect(out.itemRegions).toEqual([{ itemId: 'A', regionId: 'r1' }]);
    expect(out.gaugeHistory.map((d) => d.id)).toEqual(['g1']);

    // No surviving row references a dropped item — the result is import-safe.
    const surviving = new Set(itemIds.map(String));
    const itemRefColumns = ['item_id', 'parent_id', 'from_item_id', 'to_item_id'] as const;
    for (const rows of Object.values(out.tables)) {
      for (const row of rows) {
        for (const col of itemRefColumns) {
          if (row[col] != null) expect(surviving.has(String(row[col]))).toBe(true);
        }
      }
    }
  });

  it('keeps a row whose item reference is nullable, clearing the link instead', () => {
    const out = filterSnapshot(makeSnapshot(), { includeHistory: true, includeRemovedItems: false });

    // A purchase-order line records money actually spent, so it survives its item's removal
    // with `item_id` cleared (the column is ON DELETE SET NULL) rather than being dropped.
    expect(out.tables.purchase_order_lines).toEqual([{ id: 'pol1', po_id: 'po1', item_id: null, qty: 2 }]);
  });

  it('terminates on a parent_id cycle rather than looping forever', () => {
    // Nothing in the schema prevents a `parent_id` cycle, and a snapshot can be hand-edited.
    // The walk must still finish; neither item is removed, so both survive.
    const base = makeSnapshot();
    const snapshot: SyncSnapshot = {
      ...base,
      tables: { ...base.tables, items: [item('X', 1, 'Y'), item('Y', 1, 'X')] },
    };

    const out = filterSnapshot(snapshot, { includeHistory: true, includeRemovedItems: false });
    expect((out.tables.items ?? []).map((r) => r.id)).toEqual(['X', 'Y']);
  });

  it('does not mutate the input snapshot', () => {
    const input = makeSnapshot();
    filterSnapshot(input, { includeHistory: false, includeRemovedItems: false });
    expect(input.tables.items).toHaveLength(5);
    expect(input.itemHistory).toHaveLength(2);
    expect(input.tables.purchase_order_lines?.[0]?.item_id).toBe('B');
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
    expect(manifest.counts).toEqual({ items: 5, images: 3 });
  });

  it('records the schema baseline when given one, and omits it otherwise (issue #84)', () => {
    const base = {
      snapshot: makeSnapshot(),
      selection: DEFAULT_BACKUP_SELECTION,
      appVersion: '9.9.9',
      createdAt: 42,
      imageCount: 0,
      hasSqlite: true,
      hasSettings: false,
    };
    // Present: a later `replace` restore can refuse an incompatible exact-copy before it
    // overwrites the live database.
    expect(buildManifest({ ...base, baselineRevision: 'abc12345' }).baselineRevision).toBe('abc12345');
    // Absent: backups predating the field stay valid rather than being blocked on it.
    expect(buildManifest(base).baselineRevision).toBeUndefined();
    expect('baselineRevision' in buildManifest(base)).toBe(false);
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
    expect(parsed.snapshot.tables.items).toHaveLength(5);
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

describe('manifest cross-check (issue #201)', () => {
  /** A complete backup, as `path → bytes`, ready to be damaged in one specific way. */
  function builtEntries(overrides: Partial<Parameters<typeof assembleBackup>[0]> = {}) {
    const built = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: fakeSqlite(),
      images: [{ name: 'a.webp', bytes: new Uint8Array([9, 8, 7]) }],
      settings: { 'gubbins:layout': '{}' },
      appVersion: '1.0.0',
      createdAt: 10,
      ...overrides,
    });
    return toEntries(built.files, built.assets);
  }

  /** Re-serialise the manifest after mutating it, as a hand-edited/older backup would look. */
  function withManifest(entries: Record<string, Uint8Array>, edit: (manifest: BackupManifest) => unknown) {
    const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as BackupManifest;
    return { ...entries, [MANIFEST_ENTRY]: strToU8(JSON.stringify(edit(manifest) ?? manifest)) };
  }

  it('checksums every entry it wrote, and accepts an undamaged backup', () => {
    const entries = builtEntries();
    const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as BackupManifest;
    expect(manifest.checksums?.algorithm).toBe(CHECKSUM_ALGORITHM);
    // Every entry bar the manifest itself, which cannot contain its own digest.
    expect(Object.keys(manifest.checksums?.entries ?? {}).sort()).toEqual(
      [SNAPSHOT_ENTRY, SETTINGS_ENTRY, DATABASE_ENTRY, 'images/a.webp'].sort(),
    );
    expect(() => parseBackupEntries(entries)).not.toThrow();
  });

  it('rejects an entry whose contents no longer match the manifest', () => {
    const entries = builtEntries();
    // A byte-level corruption the zip reader is perfectly happy to decode.
    entries[DATABASE_ENTRY] = new Uint8Array([...SQLITE_HEADER, 9, 9, 9, 9]);
    expect(() => parseBackupEntries(entries)).toThrow(/does not match the checksum/);
  });

  it('rejects a backup that lost an entry the manifest listed', () => {
    const entries = builtEntries();
    delete entries['images/a.webp'];
    expect(() => parseBackupEntries(entries)).toThrow(/should contain "images\/a\.webp"/);
  });

  it('skips verification for a digest algorithm this build does not know', () => {
    // Forward-compatibility: a safety net we cannot read must not condemn a sound backup.
    const entries = withManifest(builtEntries(), (manifest) => ({
      ...manifest,
      checksums: { algorithm: 'sha3-512-from-the-future', entries: { [SNAPSHOT_ENTRY]: 'nonsense' } },
    }));
    expect(() => parseBackupEntries(entries)).not.toThrow();
  });

  it('rejects a snapshot with fewer items than the manifest recorded', () => {
    // The damage class from issue #151: the snapshot parses, defaults its missing sections to
    // empty, and would otherwise preview as internally consistent.
    const entries = builtEntries();
    const snapshot = JSON.parse(strFromU8(entries[SNAPSHOT_ENTRY]!)) as SyncSnapshot;
    const truncated = {
      ...snapshot,
      tables: { ...snapshot.tables, items: snapshot.tables.items!.slice(0, 2) },
    };
    // Restamp the digest too, so it is the *count* check being exercised and not the checksum.
    const damaged = withManifest(
      { ...entries, [SNAPSHOT_ENTRY]: strToU8(JSON.stringify(truncated)) },
      (m) => ({
        ...m,
        checksums: {
          algorithm: CHECKSUM_ALGORITHM,
          entries: {
            ...m.checksums!.entries,
            [SNAPSHOT_ENTRY]: checksumBytes(strToU8(JSON.stringify(truncated))),
          },
        },
      }),
    );
    expect(() => parseBackupEntries(damaged)).toThrow(/should contain 5 items, but only 2 could be read/);
  });

  it('rejects a backup missing a part its manifest says it contains', () => {
    const entries = withManifest(builtEntries(), (manifest) => ({
      ...manifest,
      checksums: undefined, // an older backup, checked on `contents`/`counts` alone
    }));
    delete entries[DATABASE_ENTRY];
    expect(() => parseBackupEntries(entries)).toThrow(/exact database copy, but that part is missing/);
  });

  it('rejects a snapshot that lost a whole section the manifest recorded', () => {
    const entries = builtEntries();
    const snapshot = JSON.parse(strFromU8(entries[SNAPSHOT_ENTRY]!)) as SyncSnapshot;
    const gutted = JSON.stringify({ ...snapshot, itemHistory: [], gaugeHistory: [], stockDeltas: [] });
    const damaged = withManifest({ ...entries, [SNAPSHOT_ENTRY]: strToU8(gutted) }, (m) => ({
      ...m,
      checksums: {
        algorithm: CHECKSUM_ALGORITHM,
        entries: { ...m.checksums!.entries, [SNAPSHOT_ENTRY]: checksumBytes(strToU8(gutted)) },
      },
    }));
    expect(() => parseBackupEntries(damaged)).toThrow(/no history could be read/);
  });

  it('treats a manifest with the right kind but the wrong shape as no manifest', () => {
    // A hand-edited or partly-overwritten manifest must not surface as a raw
    // "Cannot read properties of undefined" from inside the integrity check.
    for (const shape of [
      { kind: 'gubbins-backup' }, // no contents/counts at all
      { kind: 'gubbins-backup', contents: {}, counts: { items: 'five', images: 0 } },
      { kind: 'gubbins-backup', contents: [], counts: { items: 5, images: 1 } },
    ]) {
      const entries = { ...builtEntries(), [MANIFEST_ENTRY]: strToU8(JSON.stringify(shape)) };
      const parsed = parseBackupEntries(entries);
      expect(parsed.manifest).toBeNull();
      expect(parsed.snapshot.tables.items).toHaveLength(5); // the payload still restores
    }
  });

  it('ignores a malformed digest block without condemning the backup', () => {
    for (const checksums of [
      { algorithm: CHECKSUM_ALGORITHM },
      { algorithm: CHECKSUM_ALGORITHM, entries: 'nope' },
    ]) {
      const entries = withManifest(builtEntries(), (manifest) => ({ ...manifest, checksums }));
      const parsed = parseBackupEntries(entries);
      expect(parsed.manifest?.checksums).toBeUndefined();
    }
  });

  it('still reads a backup that carries no manifest at all', () => {
    const entries = builtEntries();
    delete entries[MANIFEST_ENTRY];
    const parsed = parseBackupEntries(entries);
    expect(parsed.manifest).toBeNull();
    expect(parsed.manifestUnreadable).toBe(false); // an old backup, not a damaged one
    expect(parsed.snapshot.tables.items).toHaveLength(5);
  });
});

describe('manifest field validation (issue #353)', () => {
  function builtEntries() {
    const built = assembleBackup({
      snapshot: makeSnapshot(),
      sqlite: fakeSqlite(),
      images: [],
      settings: null,
      appVersion: '1.0.0',
      baselineRevision: 'abc12345',
      createdAt: 10,
    });
    return toEntries(built.files, built.assets);
  }

  /** Re-serialise the manifest with one field replaced, as a hand-edited backup would look. */
  function withField(field: string, value: unknown) {
    const entries = builtEntries();
    const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as Record<string, unknown>;
    return { ...entries, [MANIFEST_ENTRY]: strToU8(JSON.stringify({ ...manifest, [field]: value })) };
  }

  it('accepts a well-formed manifest and reports it as readable', () => {
    const parsed = parseBackupEntries(builtEntries());
    expect(parsed.manifest?.appVersion).toBe('1.0.0');
    expect(parsed.manifest?.createdAt).toBe(10);
    expect(parsed.manifest?.baselineRevision).toBe('abc12345');
    expect(parsed.manifestUnreadable).toBe(false);
  });

  it.each([
    ['formatVersion', 'one'],
    ['formatVersion', 1.5],
    ['appVersion', 3],
    ['createdAt', '2026-01-01'],
    ['createdAt', Number.NaN],
    ['createdAt', 1e21], // beyond what `new Date()` can represent — the preview would show nothing
    // The one that gates a destructive restore: a non-string stamp neither matches the build's
    // revision nor reads as "this backup predates the field".
    ['baselineRevision', 7],
    ['baselineRevision', { revision: 'abc12345' }],
    ['baselineRevision', null],
  ])('drops a manifest whose %s is %o, and flags it as damaged', (field, value) => {
    const parsed = parseBackupEntries(withField(field, value));
    expect(parsed.manifest).toBeNull();
    expect(parsed.manifestUnreadable).toBe(true);
    expect(parsed.snapshot.tables.items).toHaveLength(5); // the payload still restores by merge
  });

  it('flags an unparseable manifest as damaged rather than absent', () => {
    const entries = { ...builtEntries(), [MANIFEST_ENTRY]: strToU8('{ not json') };
    const parsed = parseBackupEntries(entries);
    expect(parsed.manifest).toBeNull();
    expect(parsed.manifestUnreadable).toBe(true);
  });

  it('keeps no stray properties from the file', () => {
    const parsed = parseBackupEntries(withField('somethingElse', 'ignored'));
    expect(parsed.manifest).not.toBeNull();
    expect('somethingElse' in parsed.manifest!).toBe(false);
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
    expect(parsed.snapshot.tables.items).toHaveLength(5);
    expect(parsed.sqlite).not.toBeNull();
  });

  it('rejects a bare-JSON snapshot (the legacy format is no longer accepted)', () => {
    // The pre-zip "Download backup" bare-`.json` output is not a valid backup any more; only
    // the `.zip` container is. A bare JSON blob is not a zip, so it is refused.
    const bare = strToU8(JSON.stringify(makeSnapshot()));
    expect(() => readBackupFile(bare)).toThrow(InvalidBackupError);
  });

  it('rejects a file that is not a zip', () => {
    expect(() => readBackupFile(strToU8('definitely not a backup'))).toThrow(InvalidBackupError);
  });
});
