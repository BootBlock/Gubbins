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
    const dataExport = buildJsonExport({ items: [], contacts: [], checkouts: [] });
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
});
