import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';

/** Seed the minimal items-graph dependency a supplier_part FK needs. */
async function seedItem(driver: MemoryDriver, id = 'item-1'): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
    id,
    'Resistor',
    UNASSIGNED_LOCATION_ID,
  ]);
}

describe('v22 supplier-parts migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    // `>=` so the assertions survive a later sibling bump (e.g. v21 / v23 merging in).
    await runMigrations(
      driver,
      migrations.filter((m) => m.version <= 22),
    );
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches at least schema version 22 and registers v22', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(22);
    const v22 = migrations.find((m) => m.version === 22);
    expect(v22?.name).toBe('supplier-parts');
  });

  it('creates the supplier_parts table', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;",
      ['supplier_parts'],
    );
    expect(tables.map((t) => t.name)).toEqual(['supplier_parts']);
  });

  it('stores a supplier part with nullable cost/currency/pack/breaks', async () => {
    await seedItem(driver);
    await driver.execute(
      `INSERT INTO supplier_parts (id, item_id, supplier_name) VALUES (?, ?, ?);`,
      ['sp-1', 'item-1', 'DigiKey'],
    );
    const row = await driver.queryOne<{
      unit_cost: number | null;
      currency: string | null;
      pack_qty: number | null;
      min_order_qty: number | null;
      price_breaks: string | null;
      url: string | null;
      is_preferred: number;
    }>('SELECT * FROM supplier_parts WHERE id = ?;', ['sp-1']);
    expect(row?.unit_cost).toBeNull();
    expect(row?.currency).toBeNull();
    expect(row?.pack_qty).toBeNull();
    expect(row?.min_order_qty).toBeNull();
    expect(row?.price_breaks).toBeNull();
    expect(row?.url).toBeNull();
    expect(row?.is_preferred).toBe(0);
  });

  it('cascades supplier_parts when the parent item is deleted (ON DELETE CASCADE)', async () => {
    await seedItem(driver);
    await driver.execute(
      `INSERT INTO supplier_parts (id, item_id, supplier_name) VALUES (?, ?, ?);`,
      ['sp-2', 'item-1', 'RS'],
    );
    await driver.execute('DELETE FROM items WHERE id = ?;', ['item-1']);
    const rows = await driver.query('SELECT id FROM supplier_parts WHERE item_id = ?;', ['item-1']);
    expect(rows).toHaveLength(0);
  });

  it('rejects a negative unit_cost and a non-positive pack/MOQ (CHECK constraints)', async () => {
    await seedItem(driver);
    await expect(
      driver.execute(
        `INSERT INTO supplier_parts (id, item_id, supplier_name, unit_cost) VALUES (?, ?, ?, ?);`,
        ['sp-neg', 'item-1', 'Bad', -1],
      ),
    ).rejects.toThrow();
    await expect(
      driver.execute(
        `INSERT INTO supplier_parts (id, item_id, supplier_name, pack_qty) VALUES (?, ?, ?, ?);`,
        ['sp-pack', 'item-1', 'Bad', 0],
      ),
    ).rejects.toThrow();
    await expect(
      driver.execute(
        `INSERT INTO supplier_parts (id, item_id, supplier_name, is_preferred) VALUES (?, ?, ?, ?);`,
        ['sp-pref', 'item-1', 'Bad', 2],
      ),
    ).rejects.toThrow();
  });

  it('auto-stamps updated_at on a modification (§7.1 LWW pass-through)', async () => {
    await seedItem(driver);
    await driver.execute(
      `INSERT INTO supplier_parts (id, item_id, supplier_name, updated_at) VALUES (?, ?, ?, ?);`,
      ['sp-3', 'item-1', 'Mouser', 1],
    );
    await driver.execute('UPDATE supplier_parts SET supplier_name = ? WHERE id = ?;', [
      'Mouser Electronics',
      'sp-3',
    ]);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM supplier_parts WHERE id = ?;',
      ['sp-3'],
    );
    expect(Number(row?.updated_at)).toBeGreaterThan(1);
  });
});
