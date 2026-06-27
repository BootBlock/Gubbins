import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import {
  UNASSIGNED_LOCATION_ID,
  UNASSIGNED_LOCATION_NAME,
} from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v2 core-domain migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('has applied at least the v2 core-domain migration', async () => {
    // The full migration set advances past 2 as later phases land (v3+); assert the
    // v2 domain is reachable rather than pinning the latest version here.
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(2);
  });

  it('creates the domain tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    const names = tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['categories', 'items', 'item_history', 'locations']));
  });

  it('seeds the system-locked Unassigned location with its fixed id', async () => {
    const row = await driver.queryOne<{ name: string; is_system: number; parent_id: string | null }>(
      'SELECT name, is_system, parent_id FROM locations WHERE id = ?;',
      [UNASSIGNED_LOCATION_ID],
    );
    expect(row?.name).toBe(UNASSIGNED_LOCATION_NAME);
    expect(row?.is_system).toBe(1);
    expect(row?.parent_id).toBeNull();
  });

  it('forbids modifying the Unassigned location', async () => {
    await expect(
      driver.execute('UPDATE locations SET name = ? WHERE id = ?;', ['Hacked', UNASSIGNED_LOCATION_ID]),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('forbids deleting the Unassigned location', async () => {
    await expect(
      driver.execute('DELETE FROM locations WHERE id = ?;', [UNASSIGNED_LOCATION_ID]),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a location parented to itself', async () => {
    await expect(
      driver.execute(
        'INSERT INTO locations (id, name, parent_id) VALUES (?, ?, ?);',
        ['loc-self', 'Self', 'loc-self'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('enforces foreign keys between items and locations', async () => {
    await expect(
      driver.execute(
        'INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);',
        ['item-1', 'Orphan', 'no-such-location'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a CONSUMABLE_GAUGE item missing its gauge fields', async () => {
    await expect(
      driver.execute(
        `INSERT INTO items (id, name, location_id, tracking_mode)
         VALUES (?, ?, ?, 'CONSUMABLE_GAUGE');`,
        ['item-gauge', 'Filament', UNASSIGNED_LOCATION_ID],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a SERIALISED item with quantity other than 1', async () => {
    await expect(
      driver.execute(
        `INSERT INTO items (id, name, location_id, tracking_mode, quantity)
         VALUES (?, ?, ?, 'SERIALISED', 4);`,
        ['item-ser', 'Printer', UNASSIGNED_LOCATION_ID],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('auto-stamps items.updated_at on modification', async () => {
    await driver.execute(
      'INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, 1000);',
      ['item-2', 'Widget', UNASSIGNED_LOCATION_ID],
    );
    await driver.execute('UPDATE items SET name = ? WHERE id = ?;', ['Widget v2', 'item-2']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM items WHERE id = ?;',
      ['item-2'],
    );
    expect(row?.updated_at).toBeGreaterThan(1000);
  });

  it('treats item_history as an immutable, append-only ledger', async () => {
    await driver.execute(
      'INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);',
      ['item-3', 'Logged', UNASSIGNED_LOCATION_ID],
    );
    await driver.execute(
      "INSERT INTO item_history (id, item_id, action, note) VALUES (?, ?, 'CREATED', 'made');",
      ['hist-1', 'item-3'],
    );
    await expect(
      driver.execute("UPDATE item_history SET note = 'tampered' WHERE id = ?;", ['hist-1']),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades item_history when an item is hard-deleted', async () => {
    await driver.execute(
      'INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);',
      ['item-4', 'Doomed', UNASSIGNED_LOCATION_ID],
    );
    await driver.execute(
      "INSERT INTO item_history (id, item_id, action) VALUES (?, ?, 'CREATED');",
      ['hist-2', 'item-4'],
    );
    await driver.execute('DELETE FROM items WHERE id = ?;', ['item-4']);
    const rows = await driver.query('SELECT id FROM item_history WHERE item_id = ?;', ['item-4']);
    expect(rows).toHaveLength(0);
  });
});
