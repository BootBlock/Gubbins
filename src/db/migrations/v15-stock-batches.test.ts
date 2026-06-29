import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v15 stock-batches migration', () => {
  let driver: MemoryDriver;

  async function makeItem(id: string, locationId: string, quantity: number): Promise<void> {
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity) VALUES (?, ?, ?, 'DISCRETE', ?);`,
      [id, `Item ${id}`, locationId, quantity],
    );
    await driver.execute(
      `INSERT INTO item_stock (id, item_id, location_id, quantity) VALUES (?, ?, ?, ?);`,
      [`${id}|${locationId}`, id, locationId, quantity],
    );
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-a', 'Drawer A']);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('runs the v15 migration on the way to the current schema', async () => {
    // Later phases bump `user_version` further; v15 only guarantees it is *at least* 15.
    const v15 = migrations.find((m) => m.version === 15);
    expect(v15?.name).toBe('stock-batches');
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBeGreaterThanOrEqual(15);
  });

  it('backfills one deterministic default (untracked) batch row per existing placement', async () => {
    // Seed a placement *before* re-running the backfill shape the repository would create.
    await makeItem('i1', 'loc-a', 7);
    await driver.execute(
      `INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity) VALUES (?, ?, ?, '', ?);`,
      ['i1|loc-a|', 'i1', 'loc-a', 7],
    );
    const row = await driver.queryOne<{ id: string; batch_key: string; quantity: number }>(
      'SELECT id, batch_key, quantity FROM stock_batches WHERE item_id = ?;',
      ['i1'],
    );
    expect(row?.id).toBe('i1|loc-a|');
    expect(row?.batch_key).toBe('');
    expect(row?.quantity).toBe(7);
  });

  it('keeps item_stock.quantity = SUM(stock_batches) per placement, chaining to items.quantity', async () => {
    await makeItem('i1', 'loc-a', 0);
    // Two distinct batches at the same placement: 5 of lot A + 3 of lot B → placement 8.
    await driver.execute(
      `INSERT INTO stock_batches (id, item_id, location_id, batch_key, batch_number, expiry_date, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['i1|loc-a|A', 'i1', 'loc-a', 'A', 'A', 100, 5],
    );
    await driver.execute(
      `INSERT INTO stock_batches (id, item_id, location_id, batch_key, batch_number, expiry_date, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      ['i1|loc-a|B', 'i1', 'loc-a', 'B', 'B', 200, 3],
    );
    const placement = await driver.queryOne<{ quantity: number }>(
      'SELECT quantity FROM item_stock WHERE id = ?;',
      ['i1|loc-a'],
    );
    expect(placement?.quantity).toBe(8); // recompute upserted/updated the placement
    const item = await driver.queryOne<{ quantity: number }>('SELECT quantity FROM items WHERE id = ?;', ['i1']);
    expect(item?.quantity).toBe(8); // chained through the v13 item_stock → items trigger

    // Drawing a batch down re-derives both projections.
    await driver.execute('UPDATE stock_batches SET quantity = 1 WHERE id = ?;', ['i1|loc-a|A']);
    const afterDraw = await driver.queryOne<{ quantity: number }>('SELECT quantity FROM items WHERE id = ?;', ['i1']);
    expect(afterDraw?.quantity).toBe(4);
  });

  it('a batch received into a placement with no prior item_stock row creates that placement', async () => {
    await makeItem('i1', 'loc-a', 2);
    await driver.execute('INSERT INTO locations (id, name) VALUES (?, ?);', ['loc-b', 'Drawer B']);
    // No item_stock row at loc-b yet; inserting a batch there must seed it.
    await driver.execute(
      `INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity) VALUES (?, ?, ?, '', ?);`,
      ['i1|loc-b|', 'i1', 'loc-b', 6],
    );
    const placement = await driver.queryOne<{ quantity: number }>(
      'SELECT quantity FROM item_stock WHERE id = ?;',
      ['i1|loc-b'],
    );
    expect(placement?.quantity).toBe(6);
    const item = await driver.queryOne<{ quantity: number }>('SELECT quantity FROM items WHERE id = ?;', ['i1']);
    expect(item?.quantity).toBe(8); // 2 at loc-a + 6 at loc-b
  });

  it('enforces the batch CHECK and per-placement uniqueness, and cascades on item delete', async () => {
    await makeItem('i1', 'loc-a', 0);
    await driver.execute(
      `INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity) VALUES (?, ?, ?, '', 3);`,
      ['i1|loc-a|', 'i1', 'loc-a'],
    );
    // Negative quantity trips the CHECK.
    await expect(
      driver.execute('UPDATE stock_batches SET quantity = -1 WHERE id = ?;', ['i1|loc-a|']),
    ).rejects.toThrow();
    // Same (item, location, batch_key) trips UNIQUE.
    await expect(
      driver.execute(
        `INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity) VALUES (?, ?, ?, '', 1);`,
        ['dup', 'i1', 'loc-a'],
      ),
    ).rejects.toThrow();
    // Hard-deleting the item cascades its batch rows.
    await driver.execute('DELETE FROM items WHERE id = ?;', ['i1']);
    const rows = await driver.query('SELECT id FROM stock_batches WHERE item_id = ?;', ['i1']);
    expect(rows).toHaveLength(0);
  });
});
