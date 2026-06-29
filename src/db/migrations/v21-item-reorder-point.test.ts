import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v21 item-reorder-point migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches at least schema version 21 and registers v21', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(21);
    const v21 = migrations.find((m) => m.version === 21);
    expect(v21?.name).toBe('item-reorder-point');
  });

  it('adds nullable reorder columns (no backfill)', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null; type: string }>(
      'PRAGMA table_info(items);',
    );
    const expected: Record<string, string> = {
      reorder_point: 'INTEGER',
      reorder_gauge_percent: 'REAL',
      reorder_qty: 'INTEGER',
    };
    for (const [name, type] of Object.entries(expected)) {
      const col = cols.find((c) => c.name === name);
      expect(col, `expected column ${name}`).toBeDefined();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
      expect(col?.type).toBe(type);
    }
  });

  it('defaults all three to NULL for an item with no override', async () => {
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity)
       VALUES (?, ?, ?, ?, ?);`,
      ['itm-a', 'M3 screw', '00000000-0000-4000-8000-000000000001', 'DISCRETE', 100],
    );
    const row = await driver.queryOne<{
      reorder_point: number | null;
      reorder_gauge_percent: number | null;
      reorder_qty: number | null;
    }>('SELECT reorder_point, reorder_gauge_percent, reorder_qty FROM items WHERE id = ?;', ['itm-a']);
    expect(row?.reorder_point).toBeNull();
    expect(row?.reorder_gauge_percent).toBeNull();
    expect(row?.reorder_qty).toBeNull();
  });

  it('stores a per-item reorder point, gauge percentage and top-up quantity', async () => {
    await driver.execute(
      `INSERT INTO items
         (id, name, location_id, tracking_mode, quantity, reorder_point, reorder_gauge_percent, reorder_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      ['itm-b', 'Specialist connector', '00000000-0000-4000-8000-000000000001', 'DISCRETE', 3, 10, 25.5, 50],
    );
    const row = await driver.queryOne<{
      reorder_point: number | null;
      reorder_gauge_percent: number | null;
      reorder_qty: number | null;
    }>('SELECT reorder_point, reorder_gauge_percent, reorder_qty FROM items WHERE id = ?;', ['itm-b']);
    expect(row?.reorder_point).toBe(10);
    expect(row?.reorder_gauge_percent).toBeCloseTo(25.5);
    expect(row?.reorder_qty).toBe(50);
  });
});
