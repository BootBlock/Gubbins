import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { captureSchemaSnapshot } from './__fixtures__/schema-snapshot';
import goldenSnapshot from './__fixtures__/schema-baseline.snapshot.json';

/**
 * Schema-baseline lock (Phase 69 consolidation, re-squashed by the Add-item
 * enrichment work).
 *
 * `schema-baseline.snapshot.json` is the committed GOLDEN fixture — the full,
 * deterministic schema dump (every `sqlite_master.sql`, every column / FK / index, and
 * `user_version`) the registered migration chain produces. These tests build a fresh
 * database from the registered `migrations` and assert the resulting schema reproduces the
 * fixture **byte-for-byte**, so any unintended schema change (an edited table, index,
 * trigger, FK or column) fails until the fixture is deliberately regenerated. The fixture
 * is regenerated only when the schema intentionally changes — most recently the re-squash
 * of the v2–v4 forward steps into the baseline alongside `items.notes` (in the table and
 * the FTS index) and the `UNTRACKED` tracking mode, which reset the recorded
 * `user_version` back to 1.
 */
describe('schema baseline lock', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('registers the single consolidated baseline, targeting version 1', () => {
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toBe(v1Initial);
    expect(v1Initial.version).toBe(1);
    expect(TARGET_SCHEMA_VERSION).toBe(1);
  });

  it('reproduces the golden schema shape byte-for-byte (zero unintended drift)', async () => {
    await runMigrations(driver, migrations);
    const snapshot = await captureSchemaSnapshot(driver);

    // The schema SHAPE — every sqlite_master.sql object, and every table's columns,
    // foreign keys and indexes — must be byte-for-byte identical to the committed golden.
    expect(snapshot.objects).toEqual(goldenSnapshot.objects);
    expect(snapshot.tables).toEqual(goldenSnapshot.tables);
  });

  it('produces the same set of schema objects as the golden fixture', async () => {
    await runMigrations(driver, migrations);
    const snapshot = await captureSchemaSnapshot(driver);
    const names = (snap: { objects: readonly { type: string; name: string }[] }) =>
      snap.objects.map((o) => `${o.type}:${o.name}`).sort();
    expect(names(snapshot)).toEqual(names(goldenSnapshot));
  });

  it('boots a fresh database cleanly to user_version 1', async () => {
    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(0);
    expect(report.to).toBe(1);
    expect(report.applied).toEqual([1]);

    const row = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(1);
  });

  it('records the current target schema version in the golden fixture', () => {
    // The golden is the committed dump of the *current* target schema; its recorded
    // user_version therefore tracks the highest registered migration.
    expect(goldenSnapshot.userVersion).toBe(TARGET_SCHEMA_VERSION);
  });

  it('refuses a pre-squash database (user_version ahead of the target)', async () => {
    // A database left at v2–v4 by the former forward chain must be refused loudly
    // (SCHEMA_TOO_NEW → the boot rescue screen offers a reset), never silently no-opped.
    await driver.execute('PRAGMA user_version = 4;');
    await expect(runMigrations(driver, migrations)).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
    });
  });
});
