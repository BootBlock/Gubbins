import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
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
});
