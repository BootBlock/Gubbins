import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v8 procurement-lifecycle migration', () => {
  let driver: MemoryDriver;

  async function makeItem(id: string): Promise<void> {
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      id,
      `Item ${id}`,
      UNASSIGNED_LOCATION_ID,
    ]);
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations.filter((m) => m.version <= 8));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 8', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(8);
  });

  it('adds additive perishable/condition/variant columns to items, defaulting NULL', async () => {
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      'itm',
      'Solder paste',
      UNASSIGNED_LOCATION_ID,
    ]);
    const row = await driver.queryOne<{
      expiry_date: number | null;
      batch_number: string | null;
      lot_number: string | null;
      condition: string | null;
      parent_id: string | null;
    }>(
      'SELECT expiry_date, batch_number, lot_number, condition, parent_id FROM items WHERE id = ?;',
      ['itm'],
    );
    expect(row?.expiry_date).toBeNull();
    expect(row?.batch_number).toBeNull();
    expect(row?.lot_number).toBeNull();
    expect(row?.condition).toBeNull();
    expect(row?.parent_id).toBeNull();
  });

  it('persists perishable + condition values', async () => {
    await driver.execute(
      `INSERT INTO items (id, name, location_id, expiry_date, batch_number, lot_number, condition)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['itm', 'Resin', UNASSIGNED_LOCATION_ID, 1_900_000_000_000, 'B-42', 'L-7', 'GOOD'],
    );
    const row = await driver.queryOne<{ batch_number: string; condition: string }>(
      'SELECT batch_number, condition FROM items WHERE id = ?;',
      ['itm'],
    );
    expect(row?.batch_number).toBe('B-42');
    expect(row?.condition).toBe('GOOD');
  });

  it('rejects an unknown condition value', async () => {
    await expect(
      driver.execute(
        'INSERT INTO items (id, name, location_id, condition) VALUES (?, ?, ?, ?);',
        ['itm', 'X', UNASSIGNED_LOCATION_ID, 'SPARKLING'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('links a child variant to a parent item via parent_id FK', async () => {
    await makeItem('parent');
    await driver.execute(
      'INSERT INTO items (id, name, location_id, parent_id) VALUES (?, ?, ?, ?);',
      ['child', '10k', UNASSIGNED_LOCATION_ID, 'parent'],
    );
    const row = await driver.queryOne<{ parent_id: string }>(
      'SELECT parent_id FROM items WHERE id = ?;',
      ['child'],
    );
    expect(row?.parent_id).toBe('parent');
  });

  it('rejects a parent_id pointing at a non-existent item (FK enforced)', async () => {
    await expect(
      driver.execute(
        'INSERT INTO items (id, name, location_id, parent_id) VALUES (?, ?, ?, ?);',
        ['child', '10k', UNASSIGNED_LOCATION_ID, 'ghost'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('creates the maintenance_schedules table and enforces its basis CHECKs', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['maintenance_schedules']),
    );

    await makeItem('printer');
    // A TIME schedule with no interval_days is invalid.
    await expect(
      driver.execute(
        `INSERT INTO maintenance_schedules (id, item_id, name, basis) VALUES (?, ?, ?, ?);`,
        ['m1', 'printer', 'Lube rails', 'TIME'],
      ),
    ).rejects.toBeInstanceOf(DbError);
    // A valid TIME schedule.
    await driver.execute(
      `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days)
       VALUES (?, ?, ?, ?, ?);`,
      ['m2', 'printer', 'Lube rails', 'TIME', 90],
    );
    const row = await driver.queryOne<{ usage_since_service: number }>(
      'SELECT usage_since_service FROM maintenance_schedules WHERE id = ?;',
      ['m2'],
    );
    expect(row?.usage_since_service).toBe(0);
  });

  it('rejects an unknown maintenance basis', async () => {
    await makeItem('printer');
    await expect(
      driver.execute(
        `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days)
         VALUES (?, ?, ?, ?, ?);`,
        ['m1', 'printer', 'X', 'WEATHER', 1],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades maintenance schedules when the item is hard-deleted', async () => {
    await makeItem('printer');
    await driver.execute(
      `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days)
       VALUES (?, ?, ?, ?, ?);`,
      ['m1', 'printer', 'Lube rails', 'TIME', 90],
    );
    await driver.execute('DELETE FROM items WHERE id = ?;', ['printer']);
    expect(
      await driver.query('SELECT id FROM maintenance_schedules WHERE id = ?;', ['m1']),
    ).toHaveLength(0);
  });

  it('auto-stamps updated_at on maintenance schedule modification', async () => {
    await makeItem('printer');
    await driver.execute(
      `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days, updated_at)
       VALUES (?, ?, ?, ?, ?, 1000);`,
      ['m1', 'printer', 'Lube rails', 'TIME', 90],
    );
    await driver.execute(
      'UPDATE maintenance_schedules SET last_performed_at = 5000 WHERE id = ?;',
      ['m1'],
    );
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM maintenance_schedules WHERE id = ?;',
      ['m1'],
    );
    expect(row?.updated_at).toBeGreaterThan(1000);
  });
});
