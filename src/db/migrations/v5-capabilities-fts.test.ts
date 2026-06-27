import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

/**
 * `node:sqlite` (v22+/v25) bundles FTS5, so the genuine virtual-table path is
 * exercised here. If a future Node build drops it, the bootstrap probe (§2.2.1a)
 * fails loudly in the browser; these unit tests skip gracefully via this guard.
 */
const HAS_FTS5: boolean = (() => {
  const probe = createMemoryDriver();
  try {
    probe.raw.exec('CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x);');
    return true;
  } catch {
    return false;
  } finally {
    void probe.close();
  }
})();

describe('v5 capabilities-fts5-search migration', () => {
  let driver: MemoryDriver;

  async function makeItem(id: string, name: string, description?: string): Promise<void> {
    await driver.execute(
      'INSERT INTO items (id, name, description, location_id) VALUES (?, ?, ?, ?);',
      [id, name, description ?? null, UNASSIGNED_LOCATION_ID],
    );
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 5', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(5);
  });

  it('creates the capabilities table and the items_fts virtual table', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['capabilities', 'items_fts']),
    );
  });

  it('enforces one capability per (item, key) case-insensitively', async () => {
    await makeItem('itm', 'Regulator');
    await driver.execute(
      'INSERT INTO capabilities (id, item_id, key, value_num) VALUES (?, ?, ?, ?);',
      ['c1', 'itm', 'Voltage', 5],
    );
    await expect(
      driver.execute('INSERT INTO capabilities (id, item_id, key, value_num) VALUES (?, ?, ?, ?);', [
        'c2',
        'itm',
        'voltage',
        12,
      ]),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a negative capability weight', async () => {
    await makeItem('itm', 'Regulator');
    await expect(
      driver.execute(
        'INSERT INTO capabilities (id, item_id, key, weight) VALUES (?, ?, ?, ?);',
        ['c1', 'itm', 'voltage', -1],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades capabilities when the parent item is hard-deleted', async () => {
    await makeItem('itm', 'Regulator');
    await driver.execute('INSERT INTO capabilities (id, item_id, key) VALUES (?, ?, ?);', [
      'c1',
      'itm',
      'voltage',
    ]);
    await driver.execute('DELETE FROM items WHERE id = ?;', ['itm']);
    expect(await driver.query('SELECT id FROM capabilities WHERE id = ?;', ['c1'])).toHaveLength(0);
  });

  it('auto-stamps capabilities.updated_at on modification', async () => {
    await makeItem('itm', 'Regulator');
    await driver.execute(
      'INSERT INTO capabilities (id, item_id, key, updated_at) VALUES (?, ?, ?, 1000);',
      ['c1', 'itm', 'voltage'],
    );
    await driver.execute('UPDATE capabilities SET value_num = 5 WHERE id = ?;', ['c1']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM capabilities WHERE id = ?;',
      ['c1'],
    );
    expect(row?.updated_at).toBeGreaterThan(1000);
  });

  it.runIf(HAS_FTS5)(
    'keeps items_fts in sync with item inserts, updates and deletes',
    async () => {
      const match = (q: string) =>
        driver.query<{ id: string }>(
          'SELECT id FROM items WHERE rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?);',
          [q],
        );

      await makeItem('a', 'LM7805 Regulator', '5V linear supply');
      await makeItem('b', 'ESP32 DevKit', 'wifi microcontroller');

      // INSERT trigger indexed both rows.
      expect((await match('"regulator"*')).map((r) => r.id)).toEqual(['a']);
      expect((await match('"wifi"*')).map((r) => r.id)).toEqual(['b']);

      // UPDATE trigger re-indexes: 'a' is renamed away from "regulator".
      await driver.execute('UPDATE items SET name = ? WHERE id = ?;', ['LM7805 Buck', 'a']);
      expect(await match('"regulator"*')).toHaveLength(0);
      expect((await match('"buck"*')).map((r) => r.id)).toEqual(['a']);

      // DELETE trigger removes it from the index.
      await driver.execute('DELETE FROM items WHERE id = ?;', ['b']);
      expect(await match('"wifi"*')).toHaveLength(0);
    },
  );

  it.runIf(HAS_FTS5)(
    'back-fills the FTS index for items created before the migration ran',
    async () => {
      // Re-run migrations 1..4 only, insert an item, then apply v5 and confirm the
      // 'rebuild' command indexed the pre-existing row.
      const fresh = createMemoryDriver();
      await runMigrations(fresh, migrations.filter((m) => m.version <= 4));
      await fresh.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
        'old',
        'Legacy Capacitor',
        UNASSIGNED_LOCATION_ID,
      ]);
      await runMigrations(fresh, migrations);
      const rows = await fresh.query<{ id: string }>(
        'SELECT id FROM items WHERE rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?);',
        ['"capacitor"*'],
      );
      expect(rows.map((r) => r.id)).toEqual(['old']);
      await fresh.close();
    },
  );
});
