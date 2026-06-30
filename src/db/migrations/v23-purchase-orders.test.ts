import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';
import { UNASSIGNED_LOCATION_ID } from '../repositories/constants';

describe('v23 purchase-orders migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Narrowed to <= 23 so the "reaches version 23" assertion survives later bumps.
    await runMigrations(
      driver,
      migrations.filter((m) => m.version <= 23),
    );
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 23 and registers v23 last', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(23);
    const v23 = migrations.find((m) => m.version === 23);
    expect(v23?.name).toBe('purchase-orders');
  });

  it('creates the purchase_orders and purchase_order_lines tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?);",
      ['purchase_orders', 'purchase_order_lines'],
    );
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['purchase_order_lines', 'purchase_orders']);
  });

  it('defaults a new purchase order to DRAFT status with a null reference / ordered_at', async () => {
    await driver.execute('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [
      'po-1',
      'DigiKey',
    ]);
    const row = await driver.queryOne<{
      status: string;
      reference: string | null;
      ordered_at: number | null;
    }>('SELECT status, reference, ordered_at FROM purchase_orders WHERE id = ?;', ['po-1']);
    expect(row?.status).toBe('DRAFT');
    expect(row?.reference).toBeNull();
    expect(row?.ordered_at).toBeNull();
  });

  it('rejects an out-of-set status', async () => {
    await expect(
      driver.execute('INSERT INTO purchase_orders (id, supplier_name, status) VALUES (?, ?, ?);', [
        'po-bad',
        'RS',
        'SHIPPED',
      ]),
    ).rejects.toThrow();
  });

  it('rejects a non-positive ordered_qty and a negative received_qty / unit_cost', async () => {
    await driver.execute('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [
      'po-2',
      'Mouser',
    ]);
    await expect(
      driver.execute(
        'INSERT INTO purchase_order_lines (id, po_id, ordered_qty) VALUES (?, ?, ?);',
        ['l-bad-qty', 'po-2', 0],
      ),
    ).rejects.toThrow();
    await expect(
      driver.execute(
        'INSERT INTO purchase_order_lines (id, po_id, ordered_qty, received_qty) VALUES (?, ?, ?, ?);',
        ['l-bad-recv', 'po-2', 5, -1],
      ),
    ).rejects.toThrow();
    await expect(
      driver.execute(
        'INSERT INTO purchase_order_lines (id, po_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?);',
        ['l-bad-cost', 'po-2', 5, -0.5],
      ),
    ).rejects.toThrow();
  });

  it('cascades lines when their purchase order is deleted', async () => {
    await driver.execute('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [
      'po-3',
      'Farnell',
    ]);
    await driver.execute(
      'INSERT INTO purchase_order_lines (id, po_id, ordered_qty) VALUES (?, ?, ?);',
      ['l-3', 'po-3', 10],
    );

    await driver.execute('DELETE FROM purchase_orders WHERE id = ?;', ['po-3']);

    const lines = await driver.query('SELECT id FROM purchase_order_lines WHERE po_id = ?;', [
      'po-3',
    ]);
    expect(lines).toHaveLength(0);
  });

  it('NULLs a line item_id (SET NULL) when its item is deleted, keeping the line', async () => {
    await driver.execute('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [
      'po-4',
      'RS',
    ]);
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      'item-4',
      'Capacitor',
      UNASSIGNED_LOCATION_ID,
    ]);
    await driver.execute(
      'INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty) VALUES (?, ?, ?, ?);',
      ['l-4', 'po-4', 'item-4', 7],
    );

    await driver.execute('DELETE FROM items WHERE id = ?;', ['item-4']);

    const row = await driver.queryOne<{ item_id: string | null }>(
      'SELECT item_id FROM purchase_order_lines WHERE id = ?;',
      ['l-4'],
    );
    // The line survives (the order is real) but loses its item reference.
    expect(row).toBeDefined();
    expect(row?.item_id).toBeNull();
  });

  it('NULLs a line supplier_part_id (SET NULL) when its supplier part is deleted', async () => {
    await driver.execute('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [
      'po-5',
      'DigiKey',
    ]);
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      'item-5',
      'Diode',
      UNASSIGNED_LOCATION_ID,
    ]);
    await driver.execute(
      'INSERT INTO supplier_parts (id, item_id, supplier_name) VALUES (?, ?, ?);',
      ['sp-5', 'item-5', 'DigiKey'],
    );
    await driver.execute(
      'INSERT INTO purchase_order_lines (id, po_id, item_id, supplier_part_id, ordered_qty) VALUES (?, ?, ?, ?, ?);',
      ['l-5', 'po-5', 'item-5', 'sp-5', 3],
    );

    await driver.execute('DELETE FROM supplier_parts WHERE id = ?;', ['sp-5']);

    const row = await driver.queryOne<{ supplier_part_id: string | null }>(
      'SELECT supplier_part_id FROM purchase_order_lines WHERE id = ?;',
      ['l-5'],
    );
    expect(row).toBeDefined();
    expect(row?.supplier_part_id).toBeNull();
  });

  it('auto-stamps updated_at on a purchase-order modification (§7.1 LWW)', async () => {
    await driver.execute(
      'INSERT INTO purchase_orders (id, supplier_name, updated_at) VALUES (?, ?, ?);',
      ['po-6', 'Stamp', 1],
    );
    await driver.execute('UPDATE purchase_orders SET reference = ? WHERE id = ?;', ['PO-2026', 'po-6']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM purchase_orders WHERE id = ?;',
      ['po-6'],
    );
    // The pass-through guard re-stamps because the UPDATE left updated_at unchanged.
    expect(Number(row?.updated_at)).toBeGreaterThan(1);
  });

  it('auto-stamps updated_at on a line modification (§7.1 LWW)', async () => {
    await driver.execute('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [
      'po-7',
      'Stamp',
    ]);
    await driver.execute(
      'INSERT INTO purchase_order_lines (id, po_id, ordered_qty, updated_at) VALUES (?, ?, ?, ?);',
      ['l-7', 'po-7', 4, 1],
    );
    await driver.execute('UPDATE purchase_order_lines SET received_qty = ? WHERE id = ?;', [2, 'l-7']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM purchase_order_lines WHERE id = ?;',
      ['l-7'],
    );
    expect(Number(row?.updated_at)).toBeGreaterThan(1);
  });
});
