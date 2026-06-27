import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v3 category-schemas-tags-images migration', () => {
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
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 3', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(3);
  });

  it('creates the Phase 3 tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'category_fields',
        'item_field_values',
        'tags',
        'item_tags',
        'item_images',
        'item_attachments',
      ]),
    );
  });

  it('adds the additive serial_no column to items, defaulting NULL', async () => {
    await makeItem('itm');
    const row = await driver.queryOne<{ serial_no: number | null }>(
      'SELECT serial_no FROM items WHERE id = ?;',
      ['itm'],
    );
    expect(row?.serial_no).toBeNull();
  });

  it('enforces the field_type CHECK on category_fields', async () => {
    await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat', 'Resistors']);
    await expect(
      driver.execute(
        `INSERT INTO category_fields (id, category_id, name, field_type)
         VALUES (?, ?, ?, 'BOGUS');`,
        ['f1', 'cat', 'Tolerance'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades category_fields and item_field_values when a category is deleted', async () => {
    await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat', 'Caps']);
    await driver.execute(
      `INSERT INTO category_fields (id, category_id, name, field_type)
       VALUES (?, ?, 'Voltage', 'NUMBER');`,
      ['f1', 'cat'],
    );
    await makeItem('itm');
    await driver.execute(
      'INSERT INTO item_field_values (id, item_id, field_id, value) VALUES (?, ?, ?, ?);',
      ['v1', 'itm', 'f1', '16'],
    );

    await driver.execute('DELETE FROM categories WHERE id = ?;', ['cat']);

    const fields = await driver.query('SELECT id FROM category_fields WHERE id = ?;', ['f1']);
    const values = await driver.query('SELECT id FROM item_field_values WHERE id = ?;', ['v1']);
    expect(fields).toHaveLength(0);
    expect(values).toHaveLength(0);
  });

  it('enforces one value per (item, field) pair', async () => {
    await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat', 'Caps']);
    await driver.execute(
      `INSERT INTO category_fields (id, category_id, name, field_type)
       VALUES (?, ?, 'Voltage', 'NUMBER');`,
      ['f1', 'cat'],
    );
    await makeItem('itm');
    await driver.execute(
      'INSERT INTO item_field_values (id, item_id, field_id, value) VALUES (?, ?, ?, ?);',
      ['v1', 'itm', 'f1', '16'],
    );
    await expect(
      driver.execute(
        'INSERT INTO item_field_values (id, item_id, field_id, value) VALUES (?, ?, ?, ?);',
        ['v2', 'itm', 'f1', '25'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('de-duplicates tags case-insensitively', async () => {
    await driver.execute('INSERT INTO tags (id, name) VALUES (?, ?);', ['t1', 'ESP32']);
    await expect(
      driver.execute('INSERT INTO tags (id, name) VALUES (?, ?);', ['t2', 'esp32']),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('cascades item_tags, item_images and item_attachments when an item is hard-deleted', async () => {
    await makeItem('itm');
    await driver.execute('INSERT INTO tags (id, name) VALUES (?, ?);', ['t1', 'smd']);
    await driver.execute('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);', ['itm', 't1']);
    await driver.execute(
      'INSERT INTO item_images (id, item_id, full_res_opfs_path) VALUES (?, ?, ?);',
      ['img', 'itm', '/images/itm.webp'],
    );
    await driver.execute(
      `INSERT INTO item_attachments (id, item_id, kind, value) VALUES (?, ?, 'URL', ?);`,
      ['att', 'itm', 'https://example.com/ds.pdf'],
    );

    await driver.execute('DELETE FROM items WHERE id = ?;', ['itm']);

    for (const table of ['item_tags', 'item_images', 'item_attachments']) {
      const rows = await driver.query(`SELECT * FROM ${table} WHERE item_id = ?;`, ['itm']);
      expect(rows, table).toHaveLength(0);
    }
  });

  it('enforces the attachment kind CHECK', async () => {
    await makeItem('itm');
    await expect(
      driver.execute(
        `INSERT INTO item_attachments (id, item_id, kind, value) VALUES (?, ?, 'FTP', ?);`,
        ['att', 'itm', 'ftp://nope'],
      ),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('round-trips a thumbnail BLOB without Base64 (Anti-Base64 Directive §4.2.1)', async () => {
    await makeItem('itm');
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10]);
    await driver.execute(
      'INSERT INTO item_images (id, item_id, thumbnail_blob, full_res_opfs_path) VALUES (?, ?, ?, ?);',
      ['img', 'itm', bytes, '/images/itm.webp'],
    );
    const row = await driver.queryOne<{ thumbnail_blob: Uint8Array }>(
      'SELECT thumbnail_blob FROM item_images WHERE id = ?;',
      ['img'],
    );
    expect(row?.thumbnail_blob).toBeInstanceOf(Uint8Array);
    expect(Array.from(row!.thumbnail_blob)).toEqual(Array.from(bytes));
  });

  it('auto-stamps category_fields.updated_at on modification', async () => {
    await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat', 'Caps']);
    await driver.execute(
      `INSERT INTO category_fields (id, category_id, name, field_type, updated_at)
       VALUES (?, ?, 'Voltage', 'NUMBER', 1000);`,
      ['f1', 'cat'],
    );
    await driver.execute('UPDATE category_fields SET name = ? WHERE id = ?;', ['Volts', 'f1']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM category_fields WHERE id = ?;',
      ['f1'],
    );
    expect(row?.updated_at).toBeGreaterThan(1000);
  });
});
