import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v18 attachment-origin-device migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-a', 'Workshop']);
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity) VALUES (?, 'NE555', 'loc-a', 'DISCRETE', 1);`,
      ['it-1'],
    );
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches at least schema version 18 and registers v18 last', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(18);
    const v18 = migrations.find((m) => m.version === 18);
    expect(v18?.name).toBe('attachment-origin-device');
  });

  it('adds a nullable origin_device_id column to item_attachments', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(item_attachments);',
    );
    const col = cols.find((c) => c.name === 'origin_device_id');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0); // nullable — no backfill of existing rows
    expect(col?.dflt_value).toBeNull();
  });

  it('defaults origin_device_id to NULL for a legacy-style pointer', async () => {
    await driver.execute(
      `INSERT INTO item_attachments (id, item_id, kind, value) VALUES (?, 'it-1', 'LOCAL_POINTER', ?);`,
      ['att-1', 'C:\\d.pdf'],
    );
    const row = await driver.queryOne<{ origin_device_id: string | null }>(
      'SELECT origin_device_id FROM item_attachments WHERE id = ?;',
      ['att-1'],
    );
    expect(row?.origin_device_id).toBeNull();
  });

  it('stores an arbitrary device id (a synthetic identity, not a foreign key)', async () => {
    // A device id references no row, so any string is accepted even with FKs on.
    await driver.execute(
      `INSERT INTO item_attachments (id, item_id, kind, value, origin_device_id)
       VALUES (?, 'it-1', 'LOCAL_POINTER', ?, ?);`,
      ['att-2', 'C:\\d.pdf', 'device-that-exists-nowhere'],
    );
    const row = await driver.queryOne<{ origin_device_id: string | null }>(
      'SELECT origin_device_id FROM item_attachments WHERE id = ?;',
      ['att-2'],
    );
    expect(row?.origin_device_id).toBe('device-that-exists-nowhere');
  });
});
