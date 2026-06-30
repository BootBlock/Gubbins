import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v24 item-asset-lifecycle migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches at least schema version 24 and registers v24', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(24);
    const v24 = migrations.find((m) => m.version === 24);
    expect(v24?.name).toBe('item-asset-lifecycle');
  });

  it('adds the four nullable asset-lifecycle columns with the correct types', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null; type: string }>(
      'PRAGMA table_info(items);',
    );
    const expected: Record<string, string> = {
      acquired_at: 'TEXT',
      warranty_expires_at: 'TEXT',
      purchase_price: 'REAL',
      depreciation_months: 'INTEGER',
    };
    for (const [name, type] of Object.entries(expected)) {
      const col = cols.find((c) => c.name === name);
      expect(col, `expected column ${name}`).toBeDefined();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
      expect(col?.type).toBe(type);
    }
  });

  it('defaults all four columns to NULL for an existing item (additive / no backfill)', async () => {
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity)
       VALUES (?, ?, ?, ?, ?);`,
      ['itm-existing', 'Legacy widget', '00000000-0000-4000-8000-000000000001', 'DISCRETE', 5],
    );
    const row = await driver.queryOne<{
      acquired_at: string | null;
      warranty_expires_at: string | null;
      purchase_price: number | null;
      depreciation_months: number | null;
    }>(
      `SELECT acquired_at, warranty_expires_at, purchase_price, depreciation_months
       FROM items WHERE id = ?;`,
      ['itm-existing'],
    );
    expect(row?.acquired_at).toBeNull();
    expect(row?.warranty_expires_at).toBeNull();
    expect(row?.purchase_price).toBeNull();
    expect(row?.depreciation_months).toBeNull();
  });

  it('stores and retrieves all four asset-lifecycle fields', async () => {
    await driver.execute(
      `INSERT INTO items
         (id, name, location_id, tracking_mode, quantity,
          acquired_at, warranty_expires_at, purchase_price, depreciation_months)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        'itm-asset',
        'Test drill',
        '00000000-0000-4000-8000-000000000001',
        'SERIALISED',
        1,
        '2024-03-15',
        '2027-03-15',
        299.99,
        36,
      ],
    );
    const row = await driver.queryOne<{
      acquired_at: string | null;
      warranty_expires_at: string | null;
      purchase_price: number | null;
      depreciation_months: number | null;
    }>(
      `SELECT acquired_at, warranty_expires_at, purchase_price, depreciation_months
       FROM items WHERE id = ?;`,
      ['itm-asset'],
    );
    expect(row?.acquired_at).toBe('2024-03-15');
    expect(row?.warranty_expires_at).toBe('2027-03-15');
    expect(row?.purchase_price).toBeCloseTo(299.99);
    expect(row?.depreciation_months).toBe(36);
  });

  it('rejects a negative purchase_price (CHECK constraint)', async () => {
    await expect(
      driver.execute(
        `INSERT INTO items (id, name, location_id, tracking_mode, quantity, purchase_price)
         VALUES (?, ?, ?, ?, ?, ?);`,
        ['itm-bad-price', 'Bad item', '00000000-0000-4000-8000-000000000001', 'DISCRETE', 0, -1],
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-positive depreciation_months (CHECK constraint)', async () => {
    await expect(
      driver.execute(
        `INSERT INTO items (id, name, location_id, tracking_mode, quantity, depreciation_months)
         VALUES (?, ?, ?, ?, ?, ?);`,
        ['itm-bad-months', 'Bad item', '00000000-0000-4000-8000-000000000001', 'DISCRETE', 0, 0],
      ),
    ).rejects.toThrow();
  });
});
