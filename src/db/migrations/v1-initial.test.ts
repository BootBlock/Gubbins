import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations, TARGET_SCHEMA_VERSION } from './index';
import { v1Initial } from './v1-initial';
import { v2AssetBookings } from './v2-asset-bookings';
import { v3SupplierPriceHistory } from './v3-supplier-price-history';
import { v4LocationMetadata } from './v4-location-metadata';
import { captureSchemaSnapshot } from './__fixtures__/schema-snapshot';
import goldenSnapshot from './__fixtures__/schema-baseline.snapshot.json';

/**
 * Schema-baseline lock (Phase 69 consolidation + forward migrations).
 *
 * `schema-baseline.snapshot.json` is the committed GOLDEN fixture — the full,
 * deterministic schema dump (every `sqlite_master.sql`, every column / FK / index, and
 * `user_version`) the registered migration chain produces. These tests build a fresh
 * database from the registered `migrations` and assert the resulting schema reproduces the
 * fixture **byte-for-byte**, so any unintended schema change (an edited table, index,
 * trigger, FK or column) fails until the fixture is deliberately regenerated. The fixture is
 * regenerated only when the schema intentionally changes — e.g. the Phase-78 `v2`
 * `asset_bookings` forward migration, the Phase-81 `v3` `supplier_part_price_history`
 * forward migration, and the `v4` `location-metadata` forward migration, each of which
 * bumped the recorded `user_version`.
 */
describe('schema baseline lock', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('registers the v1 baseline plus the v2, v3 and v4 forward migrations, targeting version 4', () => {
    expect(migrations).toHaveLength(4);
    expect(migrations[0]).toBe(v1Initial);
    expect(migrations[1]).toBe(v2AssetBookings);
    expect(migrations[2]).toBe(v3SupplierPriceHistory);
    expect(migrations[3]).toBe(v4LocationMetadata);
    expect(v1Initial.version).toBe(1);
    expect(v2AssetBookings.version).toBe(2);
    expect(v3SupplierPriceHistory.version).toBe(3);
    expect(v4LocationMetadata.version).toBe(4);
    expect(TARGET_SCHEMA_VERSION).toBe(4);
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

  it('boots a fresh database cleanly through the chain to user_version 4', async () => {
    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(0);
    expect(report.to).toBe(4);
    expect(report.applied).toEqual([1, 2, 3, 4]);

    const row = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(4);
  });

  it('records the current target schema version in the golden fixture', () => {
    // The golden is the committed dump of the *current* target schema; its recorded
    // user_version therefore tracks the highest registered migration.
    expect(goldenSnapshot.userVersion).toBe(TARGET_SCHEMA_VERSION);
  });
});
