import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v16 checkout-source-batch migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-a', 'Drawer A']);
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity) VALUES (?, 'Tool', 'loc-a', 'DISCRETE', 5);`,
      ['it-1'],
    );
    await driver.execute('INSERT INTO contacts (id, name) VALUES (?, ?);', ['c-1', 'Sam']);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches at least schema version 16 and registers v16 last', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(16);
    const v16 = migrations.find((m) => m.version === 16);
    expect(v16?.name).toBe('checkout-source-batch');
  });

  it('adds a nullable source_batch_key column to checkouts', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(checkouts);',
    );
    const col = cols.find((c) => c.name === 'source_batch_key');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0); // nullable, so no backfill is needed
    expect(col?.dflt_value).toBeNull();
  });

  it('defaults source_batch_key to NULL for a checkout that records no specific lot', async () => {
    await driver.execute(
      `INSERT INTO checkouts (id, item_id, contact_id, quantity) VALUES (?, 'it-1', 'c-1', 1);`,
      ['k-1'],
    );
    const row = await driver.queryOne<{ source_batch_key: string | null }>(
      'SELECT source_batch_key FROM checkouts WHERE id = ?;',
      ['k-1'],
    );
    expect(row?.source_batch_key).toBeNull();
  });

  it('persists a chosen lot key and the untracked default key alike', async () => {
    await driver.execute(
      `INSERT INTO checkouts (id, item_id, contact_id, quantity, source_batch_key) VALUES (?, 'it-1', 'c-1', 1, ?);`,
      ['k-2', '["A1",null,1700000000000]'],
    );
    await driver.execute(
      `INSERT INTO checkouts (id, item_id, contact_id, quantity, source_batch_key) VALUES (?, 'it-1', 'c-1', 1, ?);`,
      ['k-3', ''],
    );
    const keys = await driver.query<{ source_batch_key: string | null }>(
      'SELECT source_batch_key FROM checkouts WHERE id IN (?, ?) ORDER BY id;',
      ['k-2', 'k-3'],
    );
    expect(keys.map((r) => r.source_batch_key)).toEqual(['["A1",null,1700000000000]', '']);
  });
});
