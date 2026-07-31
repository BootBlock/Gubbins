import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  ImageRepository,
  ItemRepository,
  LocationRepository,
  TagRepository,
  UNASSIGNED_LOCATION_ID,
} from '@/db/repositories';
import { buildJsonExport } from '@/features/export/export-data';
import { buildBackupJson, parseBackupJson, restoreFromBackupJson } from './backup';

describe('backup parse/validate (§2)', () => {
  it('rejects non-JSON', () => {
    expect(() => parseBackupJson('not json')).toThrow();
  });
  it('rejects a missing format version', () => {
    expect(() => parseBackupJson('{"tables":{}}')).toThrow(/format version/i);
  });
  it('refuses a newer format version than this build understands', () => {
    expect(() => parseBackupJson('{"formatVersion":999,"tables":{}}')).toThrow(/newer version/i);
  });
  it('accepts a well-formed envelope and fills defaults', () => {
    const snap = parseBackupJson('{"formatVersion":1}');
    expect(snap.tables).toEqual({});
    expect(snap.tombstones).toEqual([]);
  });

  // Issue #153: the export wizard's JSON is a read-only extract. It carries a formatVersion
  // and no `tables`, so it would otherwise parse as a valid *empty* snapshot and import
  // nothing while reporting success.
  it('issue #153: refuses a JSON data export by name instead of importing nothing', () => {
    const dataExport = buildJsonExport({ items: [], contacts: [], checkouts: [], locations: [] });
    expect(() => parseBackupJson(dataExport)).toThrow(/data export, not a backup/i);
  });

  // Files exported before the marker existed carry no `kind`, so the shape must catch them.
  it('issue #153: refuses an unmarked legacy data export by its shape', () => {
    const legacy = '{"formatVersion":1,"exportedAt":1,"items":[],"contacts":[],"checkouts":[]}';
    expect(() => parseBackupJson(legacy)).toThrow(/data export, not a backup/i);
  });

  // The guard must not catch a real backup of an empty database: it has a `tables` section.
  it('issue #153: still accepts a real snapshot of an empty database', () => {
    const snap = parseBackupJson('{"formatVersion":1,"tables":{},"items":[]}');
    expect(snap.tables).toEqual({});
  });
});

// Issue #351: every section used to be asserted into its structured type straight from
// JSON.parse, with only `?? []` guarding against `undefined`. A wrong-typed section then
// surfaced downstream as a raw TypeError or a driver bind error rather than a message the
// user can act on. This is not a local-file-only path — a shared sync folder feeds it too.
describe('backup envelope validation (issue #351)', () => {
  const envelope = (section: string) => `{"formatVersion":1,"tables":{},${section}}`;
  const malformed = /not in the expected format/i;

  it.each([
    ['tables is a string', '{"formatVersion":1,"tables":"hello"}'],
    ['a table section is a string', envelope('"tables":{"items":"hello"}')],
    ['a table row is an array', '{"formatVersion":1,"tables":{"items":[[]]}}'],
    ['a table row value is an object', '{"formatVersion":1,"tables":{"items":[{"id":{}}]}}'],
    ['a table section is null', '{"formatVersion":1,"tables":{"items":null}}'],
    ['itemHistory is an object', envelope('"itemHistory":{}')],
    ['an itemHistory row is a string', envelope('"itemHistory":["x"]')],
    ['itemTags is a string', envelope('"itemTags":"x"')],
    ['an itemTags edge is missing a field', envelope('"itemTags":[{"itemId":"a"}]')],
    ['an itemTags field is not a string', envelope('"itemTags":[{"itemId":"a","tagId":7}]')],
    ['a locationTags edge is malformed', envelope('"locationTags":[{"locationId":"a","tagId":null}]')],
    ['an itemRegions edge is malformed', envelope('"itemRegions":[{"itemId":"a","regionId":[]}]')],
    ['gaugeHistory is a number', envelope('"gaugeHistory":3')],
    [
      'a gauge delta amount is a string',
      envelope('"gaugeHistory":[{"id":"a","itemId":"b","netValueDelta":"5","createdAt":1}]'),
    ],
    [
      'a gauge delta timestamp is absent',
      envelope('"gaugeHistory":[{"id":"a","itemId":"b","netValueDelta":5}]'),
    ],
  ])('rejects a snapshot where %s', (_label, json) => {
    expect(() => parseBackupJson(json)).toThrow(malformed);
  });

  it('still accepts a well-formed snapshot carrying every section', () => {
    const snap = parseBackupJson(
      '{"formatVersion":1,"tables":{"items":[{"id":"i1","name":"Bolt","quantity":2,"archived":null}]},' +
        '"itemHistory":[{"id":"h1","item_id":"i1"}],"itemTags":[{"itemId":"i1","tagId":"t1"}],' +
        '"locationTags":[{"locationId":"l1","tagId":"t1"}],"itemRegions":[{"itemId":"i1","regionId":"r1"}],' +
        '"gaugeHistory":[{"id":"g1","itemId":"i1","netValueDelta":-1.5,"createdAt":123}]}',
    );
    expect(snap.itemTags).toEqual([{ itemId: 'i1', tagId: 't1' }]);
    expect(snap.gaugeHistory).toHaveLength(1);
    expect(snap.itemHistory).toHaveLength(1);
  });

  // `1e308` is ordinary, finite JSON, so a bare `typeof === 'number'` waves it through — but it is
  // outside the range `Date` can represent, and the bridge formats this stamp with `toISOString()`,
  // which throws a RangeError on an Invalid Date. The stamp is cosmetic, so fall back rather than
  // refuse the backup.
  it('replaces a generatedAt outside the representable Date range', () => {
    const snap = parseBackupJson('{"formatVersion":1,"tables":{},"generatedAt":1e308}');
    expect(Number.isNaN(new Date(snap.generatedAt).getTime())).toBe(false);
    expect(() => new Date(snap.generatedAt).toISOString()).not.toThrow();
  });

  it('keeps a generatedAt that is a usable instant', () => {
    const snap = parseBackupJson('{"formatVersion":1,"tables":{},"generatedAt":1751000000000}');
    expect(snap.generatedAt).toBe(1751000000000);
  });

  // A gauge delta's createdAt is ordered and surfaced as a date, so it takes the same range check.
  it('rejects a gauge delta timestamp outside the representable Date range', () => {
    expect(() =>
      parseBackupJson(
        envelope('"gaugeHistory":[{"id":"a","itemId":"b","netValueDelta":1,"createdAt":1e308}]'),
      ),
    ).toThrow(malformed);
  });

  // Older backups predate these sections entirely; absent must still mean empty, not a rejection.
  it('still accepts a legacy snapshot with none of the optional sections', () => {
    const snap = parseBackupJson('{"formatVersion":1,"tables":{}}');
    expect(snap.gaugeHistory).toEqual([]);
    expect(snap.itemRegions).toEqual([]);
    expect(snap.itemHistory).toEqual([]);
  });
});

describe('backup → restore round-trip (§2)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('re-creates a backed-up item that was later deleted (merge import)', async () => {
    const kept = await items.create({ name: 'In the backup', locationId: UNASSIGNED_LOCATION_ID });
    const backup = await buildBackupJson(driver);

    // Diverge: delete the backed-up item (tombstoned) and add a new local-only one.
    await items.hardDelete(kept.id);
    const transient = await items.create({ name: 'Added after backup', locationId: UNASSIGNED_LOCATION_ID });

    await restoreFromBackupJson(driver, backup);

    // The backed-up item is restored; the import is non-destructive to local-only rows.
    expect((await items.getById(kept.id))?.name).toBe('In the backup');
    expect((await items.getById(transient.id))?.name).toBe('Added after backup');
  });

  it('Phase 11: round-trips tags, thumbnails and the ledger into a fresh database', async () => {
    const tags = new TagRepository(driver);
    const images = new ImageRepository(driver);
    const item = await items.create({ name: 'Gizmo', locationId: UNASSIGNED_LOCATION_ID });
    await tags.setForItem(item.id, ['esp32', 'wifi']);
    const thumb = new Uint8Array([0, 1, 2, 250, 251, 255]); // includes high bytes
    await images.add({ itemId: item.id, thumbnailBlob: thumb, fullResOpfsPath: 'images/a.webp' });
    await driver.execute(
      'INSERT INTO item_history (id, item_id, action, note, created_at) VALUES (?, ?, ?, ?, ?);',
      ['hist-1', item.id, 'ADJUSTED', 'manual note', 1_700_000_000_000],
    );

    const backup = await buildBackupJson(driver);
    // The thumbnail must be base64-encoded (a string) so the doc is valid JSON.
    const parsed = JSON.parse(backup);
    expect(typeof parsed.tables.item_images[0].thumbnail_blob).toBe('string');
    // The local-only Phase-10 downgrade marker must never be in the synced payload.
    expect(parsed.tables.item_images[0]).not.toHaveProperty('full_res_downgraded_at');

    // Restore into a pristine second database.
    const driver2 = createMemoryDriver();
    await runMigrations(driver2, migrations);
    await restoreFromBackupJson(driver2, backup);

    const images2 = new ImageRepository(driver2);
    const restoredImages = await images2.listForItem(item.id);
    expect(restoredImages).toHaveLength(1);
    expect(Array.from(restoredImages[0]!.thumbnailBlob as Uint8Array)).toEqual(Array.from(thumb));

    const tags2 = new TagRepository(driver2);
    const restoredTags = (await tags2.getForItem(item.id)).map((t) => t.name).sort();
    expect(restoredTags).toEqual(['esp32', 'wifi']);

    const restoredHistory = await driver2.query<{ id: string; note: string }>(
      'SELECT id, note FROM item_history WHERE id = ?;',
      ['hist-1'],
    );
    expect(restoredHistory).toEqual([{ id: 'hist-1', note: 'manual note' }]);

    await driver2.close();
  });

  it('issue #84: round-trips location tags into a fresh database', async () => {
    const tags = new TagRepository(driver);
    const locations = new LocationRepository(driver);
    const location = await locations.create({ name: 'Van' });
    await tags.setForLocation(location.id, ['mobile', 'toolkit']);

    const backup = await buildBackupJson(driver);
    const parsed = JSON.parse(backup);
    expect(parsed.locationTags).toHaveLength(2);

    const driver2 = createMemoryDriver();
    await runMigrations(driver2, migrations);
    await restoreFromBackupJson(driver2, backup);

    const tags2 = new TagRepository(driver2);
    const restored = (await tags2.getForLocation(location.id)).map((t) => t.name).sort();
    expect(restored).toEqual(['mobile', 'toolkit']);

    await driver2.close();
  });

  /**
   * Issue #202: a merge restore is advertised as non-destructive, so the backup's deletion view
   * is merged with the local one instead of replacing it. A tombstone the backup carries must
   * not remove a row that is live here, and a deletion made since the backup must survive — on a
   * synced setup, dropping the local tombstone would let a peer resurrect the row.
   */
  it('issue #202: a merge keeps a live local row the backup considered deleted', async () => {
    const doomed = await items.create({
      name: 'Deleted before the backup',
      locationId: UNASSIGNED_LOCATION_ID,
    });
    await items.hardDelete(doomed.id);
    const backup = await buildBackupJson(driver); // carries a tombstone for `doomed`

    // The row comes back locally under the same id (as it would from a peer, or by undo).
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      doomed.id,
      'Back again',
      UNASSIGNED_LOCATION_ID,
    ]);
    await driver.execute('DELETE FROM tombstones WHERE table_name = ? AND id = ?;', ['items', doomed.id]);

    await restoreFromBackupJson(driver, backup);

    expect((await items.getById(doomed.id))?.name).toBe('Back again');
    // …and no tombstone was adopted for it, or the next sync would delete it anyway.
    const adopted = await driver.query('SELECT id FROM tombstones WHERE table_name = ? AND id = ?;', [
      'items',
      doomed.id,
    ]);
    expect(adopted).toEqual([]);
  });

  it('issue #202: a merge preserves a deletion made since the backup was taken', async () => {
    const removed = await items.create({
      name: 'Deleted after the backup',
      locationId: UNASSIGNED_LOCATION_ID,
    });
    const other = await items.create({ name: 'Untouched', locationId: UNASSIGNED_LOCATION_ID });
    const backup = await buildBackupJson(driver); // carries both rows, no tombstones

    await items.hardDelete(removed.id);
    await restoreFromBackupJson(driver, backup);

    // The row itself is re-created — that is what a merge restore is for — but only because the
    // backup carries it, and its tombstone is cleared so the restore is not immediately undone.
    expect((await items.getById(removed.id))?.name).toBe('Deleted after the backup');
    expect((await items.getById(other.id))?.name).toBe('Untouched');

    // A deletion the backup knows nothing about is a different matter: it must still be recorded.
    const orphan = await items.create({ name: 'Never in the backup', locationId: UNASSIGNED_LOCATION_ID });
    await items.hardDelete(orphan.id);
    await restoreFromBackupJson(driver, backup);
    const kept = await driver.query('SELECT id FROM tombstones WHERE table_name = ? AND id = ?;', [
      'items',
      orphan.id,
    ]);
    expect(kept).toHaveLength(1);
  });

  // Both sides agree the row is gone, so only the instant is in question — and rewinding it to
  // the backup's older one would drop the tombstone below the watermark that decides what still
  // needs syncing, stranding a deletion this device had yet to propagate.
  it('issue #202: adopting a tombstone keeps the later deletion instant', async () => {
    const gone = await items.create({ name: 'Deleted on both devices', locationId: UNASSIGNED_LOCATION_ID });
    await items.hardDelete(gone.id);
    await driver.execute('UPDATE tombstones SET deleted_at = ? WHERE table_name = ? AND id = ?;', [
      9000,
      'items',
      gone.id,
    ]);

    const backup = JSON.stringify({
      formatVersion: 1,
      tables: {},
      tombstones: [{ tableName: 'items', id: gone.id, deletedAt: 1000 }],
    });
    await restoreFromBackupJson(driver, backup);

    const [row] = await driver.query<{ deleted_at: number }>(
      'SELECT deleted_at FROM tombstones WHERE table_name = ? AND id = ?;',
      ['items', gone.id],
    );
    expect(row?.deleted_at).toBe(9000);
  });
});
