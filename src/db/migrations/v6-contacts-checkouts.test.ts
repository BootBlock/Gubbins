import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v6 contacts-borrowing-checkout migration', () => {
  let driver: MemoryDriver;

  async function makeItem(id: string): Promise<void> {
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      id,
      `Item ${id}`,
      UNASSIGNED_LOCATION_ID,
    ]);
  }

  async function makeContact(id: string, name: string): Promise<void> {
    await driver.execute('INSERT INTO contacts (id, name) VALUES (?, ?);', [id, name]);
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations.filter((m) => m.version <= 6));
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 6', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(6);
  });

  it('creates the Phase 6 tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['contacts', 'checkouts']),
    );
  });

  it('enforces a case-insensitive unique contact name', async () => {
    await makeContact('c1', 'Ada Lovelace');
    await expect(
      driver.execute('INSERT INTO contacts (id, name) VALUES (?, ?);', ['c2', 'ada lovelace']),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a non-positive checkout quantity', async () => {
    await makeItem('itm');
    await makeContact('c1', 'Bob');
    await expect(
      driver.execute(
        'INSERT INTO checkouts (id, item_id, contact_id, quantity) VALUES (?, ?, ?, ?);',
        ['k1', 'itm', 'c1', 0],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a return that predates the checkout', async () => {
    await makeItem('itm');
    await makeContact('c1', 'Bob');
    await expect(
      driver.execute(
        `INSERT INTO checkouts (id, item_id, contact_id, checked_out_at, returned_at)
         VALUES (?, ?, ?, ?, ?);`,
        ['k1', 'itm', 'c1', 2000, 1000],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades checkouts when the item or contact is hard-deleted', async () => {
    await makeItem('itm');
    await makeContact('c1', 'Bob');
    await driver.execute(
      'INSERT INTO checkouts (id, item_id, contact_id) VALUES (?, ?, ?);',
      ['k1', 'itm', 'c1'],
    );
    await driver.execute('DELETE FROM items WHERE id = ?;', ['itm']);
    expect(await driver.query('SELECT id FROM checkouts WHERE id = ?;', ['k1'])).toHaveLength(0);

    await makeItem('itm2');
    await driver.execute(
      'INSERT INTO checkouts (id, item_id, contact_id) VALUES (?, ?, ?);',
      ['k2', 'itm2', 'c1'],
    );
    await driver.execute('DELETE FROM contacts WHERE id = ?;', ['c1']);
    expect(await driver.query('SELECT id FROM checkouts WHERE id = ?;', ['k2'])).toHaveLength(0);
  });

  it('auto-stamps updated_at on contact and checkout modification', async () => {
    await driver.execute('INSERT INTO contacts (id, name, updated_at) VALUES (?, ?, 1000);', [
      'c1',
      'Bob',
    ]);
    await driver.execute('UPDATE contacts SET note = ? WHERE id = ?;', ['lab partner', 'c1']);
    const contact = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM contacts WHERE id = ?;',
      ['c1'],
    );
    expect(contact?.updated_at).toBeGreaterThan(1000);

    await makeItem('itm');
    await driver.execute(
      'INSERT INTO checkouts (id, item_id, contact_id, updated_at) VALUES (?, ?, ?, 1000);',
      ['k1', 'itm', 'c1'],
    );
    await driver.execute('UPDATE checkouts SET returned_at = checked_out_at WHERE id = ?;', ['k1']);
    const checkout = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM checkouts WHERE id = ?;',
      ['k1'],
    );
    expect(checkout?.updated_at).toBeGreaterThan(1000);
  });
});
