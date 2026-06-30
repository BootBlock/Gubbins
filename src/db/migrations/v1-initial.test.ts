import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { captureSchemaSnapshot } from './__fixtures__/schema-snapshot';
import goldenSnapshot from './__fixtures__/schema-baseline.snapshot.json';

/**
 * Phase 69 migration-baseline consolidation: the proof of zero schema drift.
 *
 * `schema-baseline.snapshot.json` is the committed GOLDEN fixture — the full,
 * deterministic schema dump (every `sqlite_master.sql`, every column / FK / index,
 * and `user_version`) of the ORIGINAL v1…v24 migration chain, captured once. These
 * tests build a fresh database from the NEW single `v1-initial` baseline and assert
 * the resulting schema reproduces that fixture exactly. If the squash had altered
 * any table, index, trigger, FK or column — by a byte — this fails.
 */
describe('v1-initial consolidated baseline', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('is the only registered migration and targets schema version 1', () => {
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toBe(v1Initial);
    expect(v1Initial.version).toBe(1);
    expect(TARGET_SCHEMA_VERSION).toBe(1);
  });

  it('reproduces the golden schema shape byte-for-byte (zero drift)', async () => {
    await runMigrations(driver, migrations);
    const snapshot = await captureSchemaSnapshot(driver);

    // The schema SHAPE — every sqlite_master.sql object, and every table's columns,
    // foreign keys and indexes — must be byte-for-byte identical to the original
    // v1…v24 chain. (`user_version` is the one intentional difference: the squashed
    // schema is re-baselined to 1; it is asserted separately below.)
    expect(snapshot.objects).toEqual(goldenSnapshot.objects);
    expect(snapshot.tables).toEqual(goldenSnapshot.tables);
  });

  it('produces the same set of schema objects as the original chain', async () => {
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

  it('records the original chain head in the golden fixture (user_version 24)', () => {
    // The golden fixture is the v24 head; after the squash the same schema shape is
    // produced at user_version 1 (asserted above). The fixture deliberately retains
    // the original version so the one intentional difference is explicit and pinned.
    expect(goldenSnapshot.userVersion).toBe(24);
  });
});
