import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations, getUserVersion } from './engine';
import { v1Initial } from './v1-initial';
import { v2AssetBookings } from './v2-asset-bookings';
import { v3SupplierPriceHistory } from './v3-supplier-price-history';
import { migrations, TARGET_SCHEMA_VERSION } from './index';

/**
 * Phase 81 — the v3 `supplier_part_price_history` forward migration.
 *
 * Proves the migration is **additive and forward**: an existing v2 database upgrades to v3 by
 * creating the new synced table without a wipe and without disturbing existing data.
 */
describe('v3 supplier-price-history migration', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = createMemoryDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('is the third registered migration (version 3)', () => {
    expect(migrations[2]).toBe(v3SupplierPriceHistory);
    expect(v3SupplierPriceHistory.version).toBe(3);
    // Later forward migrations may raise the target; v3 must never be the last-but-missing.
    expect(TARGET_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('a v2 database has no supplier_part_price_history table', async () => {
    await runMigrations(driver, [v1Initial, v2AssetBookings]);
    expect(await getUserVersion(driver)).toBe(2);
    const table = await driver.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'supplier_part_price_history';",
    );
    expect(table).toBeUndefined();
  });

  it('upgrades a populated v2 database forward to v3 without data loss', async () => {
    await runMigrations(driver, [v1Initial, v2AssetBookings]);
    await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat-1', 'Tools']);

    // Apply the chain up to (and including) v3 in isolation, so this stays a v3-focused
    // assertion even as later forward migrations are appended.
    const report = await runMigrations(driver, [
      v1Initial,
      v2AssetBookings,
      v3SupplierPriceHistory,
    ]);
    expect(report.from).toBe(2);
    expect(report.to).toBe(3);
    expect(report.applied).toEqual([3]);
    expect(await getUserVersion(driver)).toBe(3);

    const cat = await driver.queryOne<{ name: string }>(
      'SELECT name FROM categories WHERE id = ?;',
      ['cat-1'],
    );
    expect(cat?.name).toBe('Tools');

    const cols = await driver.query<{ name: string }>(
      'PRAGMA table_info(supplier_part_price_history);',
    );
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'supplier_part_id',
      'unit_cost',
      'currency',
      'source',
      'recorded_at',
      'updated_at',
    ]);
    const index = await driver.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_supplier_part_price_history_part';",
    );
    expect(index).toBeDefined();
    const trigger = await driver.queryOne(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_supplier_part_price_history_updated_at';",
    );
    expect(trigger).toBeDefined();
  });

  it('enforces the non-negative cost and source-enum CHECK constraints', async () => {
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    await driver.execute("INSERT INTO categories (id, name) VALUES ('c', 'C');");
    await driver.execute(
      `INSERT INTO items (id, name, location_id) VALUES ('i', 'Part', '00000000-0000-4000-8000-000000000001');`,
    );
    await driver.execute(
      "INSERT INTO supplier_parts (id, item_id, supplier_name) VALUES ('sp', 'i', 'RS');",
    );

    await expect(
      driver.execute(
        'INSERT INTO supplier_part_price_history (id, supplier_part_id, unit_cost) VALUES (?, ?, ?);',
        ['h1', 'sp', -1],
      ),
    ).rejects.toBeTruthy();
    await expect(
      driver.execute(
        'INSERT INTO supplier_part_price_history (id, supplier_part_id, unit_cost, source) VALUES (?, ?, ?, ?);',
        ['h2', 'sp', 1, 'BOGUS'],
      ),
    ).rejects.toBeTruthy();
  });
});
