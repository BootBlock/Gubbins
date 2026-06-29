import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v17 maintenance-location migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-a', 'Workshop']);
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity) VALUES (?, 'Lathe', 'loc-a', 'DISCRETE', 1);`,
      ['it-1'],
    );
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches at least schema version 17 and registers v17 last', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(17);
    const v17 = migrations.find((m) => m.version === 17);
    expect(v17?.name).toBe('maintenance-location');
  });

  it('adds a nullable location_id column to maintenance_schedules', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(maintenance_schedules);',
    );
    const col = cols.find((c) => c.name === 'location_id');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0); // nullable, so no backfill is needed
    expect(col?.dflt_value).toBeNull();
  });

  it('defaults location_id to NULL for an item-level schedule', async () => {
    await driver.execute(
      `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days) VALUES (?, 'it-1', 'Lube', 'TIME', 90);`,
      ['ms-1'],
    );
    const row = await driver.queryOne<{ location_id: string | null }>(
      'SELECT location_id FROM maintenance_schedules WHERE id = ?;',
      ['ms-1'],
    );
    expect(row?.location_id).toBeNull();
  });

  it('records a scope location and enforces its foreign key', async () => {
    await driver.execute(
      `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days, location_id)
       VALUES (?, 'it-1', 'Recalibrate', 'TIME', 30, ?);`,
      ['ms-2', 'loc-a'],
    );
    const row = await driver.queryOne<{ location_id: string | null }>(
      'SELECT location_id FROM maintenance_schedules WHERE id = ?;',
      ['ms-2'],
    );
    expect(row?.location_id).toBe('loc-a');

    await expect(
      driver.execute(
        `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days, location_id)
         VALUES (?, 'it-1', 'X', 'TIME', 30, ?);`,
        ['ms-3', 'ghost-loc'],
      ),
    ).rejects.toThrow();
  });
});
