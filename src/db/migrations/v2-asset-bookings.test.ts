import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations, getUserVersion } from './engine';
import { v1Initial } from './v1-initial';
import { v2AssetBookings } from './v2-asset-bookings';
import { migrations, TARGET_SCHEMA_VERSION } from './index';

/**
 * Phase 78 — the v2 `asset_bookings` forward migration.
 *
 * Proves the migration is **additive and forward**: an existing v1 database upgrades to v2
 * by creating the new synced table without a wipe and without disturbing existing data
 * (unlike the Phase-69 baseline squash, which reset user_version 24 → 1).
 */
describe('v2 asset-bookings migration', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('is the second registered migration and targets schema version 2', () => {
    expect(migrations).toHaveLength(2);
    expect(migrations[1]).toBe(v2AssetBookings);
    expect(v2AssetBookings.version).toBe(2);
    expect(TARGET_SCHEMA_VERSION).toBe(2);
  });

  it('a v1-only database has no asset_bookings table', async () => {
    await runMigrations(driver, [v1Initial]);
    expect(await getUserVersion(driver)).toBe(1);
    const table = await driver.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_bookings';",
    );
    expect(table).toBeUndefined();
  });

  it('upgrades a populated v1 database forward to v2 without data loss', async () => {
    // Boot to v1 and seed a row in an existing table.
    await runMigrations(driver, [v1Initial]);
    await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat-1', 'Tools']);

    // Apply the full chain on the same database — only v2 runs (v1 is already applied).
    const report = await runMigrations(driver, migrations);
    expect(report.from).toBe(1);
    expect(report.to).toBe(2);
    expect(report.applied).toEqual([2]);
    expect(await getUserVersion(driver)).toBe(2);

    // The pre-existing data survived.
    const cat = await driver.queryOne<{ name: string }>(
      'SELECT name FROM categories WHERE id = ?;',
      ['cat-1'],
    );
    expect(cat?.name).toBe('Tools');

    // The new table exists with its expected columns, index and auto-stamp trigger.
    const cols = await driver.query<{ name: string }>('PRAGMA table_info(asset_bookings);');
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'item_id',
      'contact_id',
      'start_date',
      'end_date',
      'note',
      'cancelled_at',
      'converted_checkout_id',
      'created_at',
      'updated_at',
    ]);
    const index = await driver.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_asset_bookings_item_id';",
    );
    expect(index).toBeDefined();
    const trigger = await driver.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_asset_bookings_updated_at';",
    );
    expect(trigger).toBeDefined();
  });

  it('enforces the end >= start CHECK constraint', async () => {
    await runMigrations(driver, migrations);
    // Seed a valid item to satisfy the FK.
    await driver.execute(
      "INSERT INTO categories (id, name) VALUES ('c', 'C');",
    );
    await driver.execute(
      `INSERT INTO items (id, name, location_id) VALUES ('i', 'Asset', '00000000-0000-4000-8000-000000000001');`,
    );
    await expect(
      driver.execute(
        'INSERT INTO asset_bookings (id, item_id, start_date, end_date) VALUES (?, ?, ?, ?);',
        ['b', 'i', 100, 50],
      ),
    ).rejects.toBeTruthy();
  });
});
