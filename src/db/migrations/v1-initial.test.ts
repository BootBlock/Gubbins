import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { v2WarrantyIndex } from './v2-warranty-index';
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

  it('registers the consolidated baseline plus the v2 warranty-index forward step', () => {
    expect(migrations).toHaveLength(2);
    expect(migrations[0]).toBe(v1Initial);
    expect(migrations[1]).toBe(v2WarrantyIndex);
    expect(v1Initial.version).toBe(1);
    expect(v2WarrantyIndex.version).toBe(2);
    // The build's target is simply the highest registered version.
    expect(TARGET_SCHEMA_VERSION).toBe(2);
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

  it('boots a fresh database cleanly to the target user_version', async () => {
    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(0);
    expect(report.to).toBe(2);
    expect(report.applied).toEqual([1, 2]);

    const row = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(2);
  });

  it('creates the partial warranty index on the v2 forward step', async () => {
    await runMigrations(driver, migrations);
    const index = await driver.queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_warranty';",
    );
    expect(index?.sql).toBe(
      'CREATE INDEX idx_items_warranty ON items(warranty_expires_at) WHERE warranty_expires_at IS NOT NULL',
    );
  });

  it('records the current target schema version in the golden fixture', () => {
    // The golden is the committed dump of the *current* target schema; its recorded
    // user_version therefore tracks the highest registered migration.
    expect(goldenSnapshot.userVersion).toBe(TARGET_SCHEMA_VERSION);
  });

  it('accepts is_unlimited = 1 on a DISCRETE item but rejects it on other modes', async () => {
    await runMigrations(driver, migrations);
    const loc = '00000000-0000-4000-8000-000000000001'; // seeded Unassigned location

    // DISCRETE + unlimited is the sole permitted combination — the CHECK admits it.
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity, is_unlimited)
       VALUES ('u1', 'Tap water', ?, 'DISCRETE', 0, 1);`,
      [loc],
    );

    // Every non-DISCRETE mode with is_unlimited = 1 must be refused by the DISCRETE-only CHECK.
    for (const mode of ['SERIALISED', 'UNTRACKED'] as const) {
      const qty = mode === 'SERIALISED' ? 1 : 0;
      await expect(
        driver.execute(
          `INSERT INTO items (id, name, location_id, tracking_mode, quantity, is_unlimited)
           VALUES (?, ?, ?, ?, ?, 1);`,
          [`bad-${mode}`, `Bad ${mode}`, loc, mode, qty],
        ),
      ).rejects.toThrow(/CHECK constraint failed/i);
    }
  });

  it('refuses a database whose version is ahead of the target', async () => {
    // A database left ahead of the highest registered version — e.g. a pre-squash
    // baseline stranded at the former v3–v4 forward chain — must be refused loudly
    // (SCHEMA_TOO_NEW → the boot rescue screen offers a reset), never silently no-opped.
    await driver.execute('PRAGMA user_version = 4;');
    await expect(runMigrations(driver, migrations)).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
    });
  });
});
