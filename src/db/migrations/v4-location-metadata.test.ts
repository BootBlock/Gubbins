import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations, getUserVersion } from './engine';
import { v1Initial } from './v1-initial';
import { v2AssetBookings } from './v2-asset-bookings';
import { v3SupplierPriceHistory } from './v3-supplier-price-history';
import { v4LocationMetadata } from './v4-location-metadata';
import { migrations, TARGET_SCHEMA_VERSION } from './index';

/**
 * v4 — the `location-metadata` forward migration (richer location fields).
 *
 * Proves the migration is **additive and forward**: an existing v3 database upgrades to v4 by
 * adding the four new `locations` columns without a wipe and without disturbing existing data.
 * (This replaces an earlier attempt to fold the columns into the v1 baseline, which only
 * reached freshly-wiped databases.)
 */
describe('v4 location-metadata migration', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('is the fourth registered migration and the current target', () => {
    expect(migrations).toHaveLength(4);
    expect(migrations[3]).toBe(v4LocationMetadata);
    expect(v4LocationMetadata.version).toBe(4);
    expect(TARGET_SCHEMA_VERSION).toBe(4);
  });

  it('a v3 database has none of the new location columns', async () => {
    await runMigrations(driver, [v1Initial, v2AssetBookings, v3SupplierPriceHistory]);
    expect(await getUserVersion(driver)).toBe(3);
    const cols = (await driver.query<{ name: string }>('PRAGMA table_info(locations);')).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('kind');
    expect(cols).not.toContain('capacity');
    expect(cols).not.toContain('is_default');
    expect(cols).not.toContain('archived_at');
  });

  it('upgrades a populated v3 database forward to v4 without data loss', async () => {
    await runMigrations(driver, [v1Initial, v2AssetBookings, v3SupplierPriceHistory]);
    await driver.execute("INSERT INTO locations (id, name) VALUES ('loc-1', 'Workshop');");

    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(3);
    expect(report.to).toBe(4);
    expect(report.applied).toEqual([4]);
    expect(await getUserVersion(driver)).toBe(4);

    // Pre-existing row survives and defaults sensibly for the new columns.
    const row = await driver.queryOne<{
      name: string;
      kind: string | null;
      capacity: number | null;
      is_default: number;
      archived_at: number | null;
    }>('SELECT name, kind, capacity, is_default, archived_at FROM locations WHERE id = ?;', [
      'loc-1',
    ]);
    expect(row).toMatchObject({
      name: 'Workshop',
      kind: null,
      capacity: null,
      is_default: 0,
      archived_at: null,
    });
  });

  it('enforces the capacity and is_default CHECK constraints', async () => {
    await runMigrations(driver, migrations);
    await expect(
      driver.execute("INSERT INTO locations (id, name, capacity) VALUES ('n', 'Neg', -1);"),
    ).rejects.toBeTruthy();
    await expect(
      driver.execute("INSERT INTO locations (id, name, is_default) VALUES ('b', 'Bad', 2);"),
    ).rejects.toBeTruthy();
  });
});
