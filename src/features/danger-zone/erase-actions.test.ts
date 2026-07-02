import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { eraseTargets, countTargets, type ErasePorts } from './erase-actions';

/** A minimal in-memory Storage stand-in (only the methods the engine uses). */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

/** A live integer-ms timestamp counter so each seeded row is distinguishable. */
let seq = 1;
const nextId = (prefix: string) => `${prefix}-${seq++}`;

describe('eraseTargets (memory-driver integration)', () => {
  let driver: MemoryDriver;
  let removeImagesDirectory: ReturnType<typeof vi.fn>;
  let deleteIdb: ReturnType<typeof vi.fn>;
  let local: Storage;

  /** Build the ports bag against the live driver + fakes. */
  function ports(localState?: Record<string, string>): ErasePorts {
    local = fakeStorage(localState);
    return { db: driver, removeImagesDirectory, deleteIdb, local };
  }

  async function count(table: string): Promise<number> {
    const row = await driver.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`);
    return Number(row?.n ?? 0);
  }

  async function exec(sql: string, params?: readonly (string | number | null)[]): Promise<void> {
    await driver.execute(sql, params);
  }

  /** A custom (non-system) location. */
  async function makeLocation(name: string): Promise<string> {
    const id = nextId('loc');
    await exec('INSERT INTO locations (id, name, is_system) VALUES (?, ?, 0);', [id, name]);
    return id;
  }

  /** An item at a location, optionally categorised. */
  async function makeItem(locationId: string, categoryId: string | null = null): Promise<string> {
    const id = nextId('item');
    await exec('INSERT INTO items (id, name, location_id, category_id) VALUES (?, ?, ?, ?);', [
      id,
      `Item ${id}`,
      locationId,
      categoryId,
    ]);
    return id;
  }

  beforeEach(async () => {
    seq = 1;
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    removeImagesDirectory = vi.fn(async () => {});
    deleteIdb = vi.fn(async () => {});
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('items', () => {
    beforeEach(async () => {
      const loc = await makeLocation('Shelf A');
      const cat = nextId('cat');
      await exec('INSERT INTO categories (id, name) VALUES (?, ?);', [cat, 'Resistors']);
      const field = nextId('field');
      await exec('INSERT INTO category_fields (id, category_id, name, field_type) VALUES (?, ?, ?, ?);', [
        field,
        cat,
        'Resistance',
        'NUMBER',
      ]);
      const item = await makeItem(loc, cat);

      // Children that should cascade away.
      await exec('INSERT INTO item_history (id, item_id, action) VALUES (?, ?, ?);', [
        nextId('hist'),
        item,
        'CREATED',
      ]);
      await exec('INSERT INTO item_images (id, item_id, full_res_opfs_path) VALUES (?, ?, ?);', [
        nextId('img'),
        item,
        'images/x.webp',
      ]);
      await exec('INSERT INTO item_field_values (id, item_id, field_id, value) VALUES (?, ?, ?, ?);', [
        nextId('ifv'),
        item,
        field,
        '100',
      ]);
      const tag = nextId('tag');
      await exec('INSERT INTO tags (id, name) VALUES (?, ?);', [tag, 'smd']);
      await exec('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);', [item, tag]);
      const contact = nextId('contact');
      await exec('INSERT INTO contacts (id, name) VALUES (?, ?);', [contact, 'Alex']);
      await exec('INSERT INTO checkouts (id, item_id, contact_id) VALUES (?, ?, ?);', [
        nextId('co'),
        item,
        contact,
      ]);
      await exec(
        'INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days) VALUES (?, ?, ?, ?, ?);',
        [nextId('ms'), item, 'Calibrate', 'TIME', 30],
      );
      await exec('INSERT INTO supplier_parts (id, item_id, supplier_name) VALUES (?, ?, ?);', [
        nextId('sp'),
        item,
        'Acme',
      ]);

      // Lines that should SURVIVE but be unlinked.
      const project = nextId('proj');
      await exec('INSERT INTO projects (id, name) VALUES (?, ?);', [project, 'Build']);
      await exec(
        'INSERT INTO project_bom_lines (id, project_id, item_id, required_qty) VALUES (?, ?, ?, ?);',
        [nextId('bom'), project, item, 2],
      );
      const po = nextId('po');
      await exec('INSERT INTO purchase_orders (id, supplier_name) VALUES (?, ?);', [po, 'Acme']);
      await exec('INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty) VALUES (?, ?, ?, ?);', [
        nextId('pol'),
        po,
        item,
        5,
      ]);
    });

    it('removes all items and cascades their children, but keeps unlinked BOM/PO lines and advances the watermark', async () => {
      const before = await driver.queryOne<{ n: number }>(
        'SELECT history_pruned_before AS n FROM sync_meta WHERE id = 1;',
      );

      await eraseTargets(['items'], { tombstone: false, now: 5_000 }, ports());

      expect(await count('items')).toBe(0);
      expect(await count('item_history')).toBe(0);
      expect(await count('item_images')).toBe(0);
      expect(await count('item_field_values')).toBe(0);
      expect(await count('item_tags')).toBe(0);
      expect(await count('checkouts')).toBe(0);
      expect(await count('maintenance_schedules')).toBe(0);
      expect(await count('supplier_parts')).toBe(0);

      // Lines survive with NULL item_id.
      expect(await count('project_bom_lines')).toBe(1);
      expect(await count('purchase_order_lines')).toBe(1);
      const bom = await driver.queryOne<{ item_id: string | null }>(
        'SELECT item_id FROM project_bom_lines LIMIT 1;',
      );
      expect(bom?.item_id).toBeNull();
      const pol = await driver.queryOne<{ item_id: string | null }>(
        'SELECT item_id FROM purchase_order_lines LIMIT 1;',
      );
      expect(pol?.item_id).toBeNull();

      // Watermark advanced.
      const after = await driver.queryOne<{ n: number }>(
        'SELECT history_pruned_before AS n FROM sync_meta WHERE id = 1;',
      );
      expect(Number(after?.n)).toBe(5_000);
      expect(Number(after?.n)).toBeGreaterThan(Number(before?.n));

      // Photos cleared once.
      expect(removeImagesDirectory).toHaveBeenCalledTimes(1);
    });

    it('writes NO tombstones when tombstone is off', async () => {
      await eraseTargets(['items'], { tombstone: false }, ports());
      expect(await count('tombstones')).toBe(0);
    });

    it('writes tombstones (but never for item_history) when tombstone is on', async () => {
      await eraseTargets(['items'], { tombstone: true }, ports());
      expect(await count('tombstones')).toBeGreaterThan(0);
      const historyTombstones = await driver.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'item_history';",
      );
      expect(Number(historyTombstones?.n)).toBe(0);
      // The item_tags edge tombstone uses the composite key form.
      const edge = await driver.queryOne<{ id: string }>(
        "SELECT id FROM tombstones WHERE table_name = 'item_tags' LIMIT 1;",
      );
      expect(edge?.id).toContain('|');
    });
  });

  describe('categories', () => {
    it('nulls items.category_id and removes category_fields + item_field_values', async () => {
      const loc = await makeLocation('Bin');
      const cat = nextId('cat');
      await exec('INSERT INTO categories (id, name) VALUES (?, ?);', [cat, 'Caps']);
      const field = nextId('field');
      await exec('INSERT INTO category_fields (id, category_id, name, field_type) VALUES (?, ?, ?, ?);', [
        field,
        cat,
        'Voltage',
        'NUMBER',
      ]);
      const item = await makeItem(loc, cat);
      await exec('INSERT INTO item_field_values (id, item_id, field_id, value) VALUES (?, ?, ?, ?);', [
        nextId('ifv'),
        item,
        field,
        '25',
      ]);

      await eraseTargets(['categories'], { tombstone: true }, ports());

      expect(await count('categories')).toBe(0);
      expect(await count('category_fields')).toBe(0);
      expect(await count('item_field_values')).toBe(0);
      expect(await count('items')).toBe(1);
      const survivor = await driver.queryOne<{ category_id: string | null }>(
        'SELECT category_id FROM items LIMIT 1;',
      );
      expect(survivor?.category_id).toBeNull();
    });
  });

  describe('contacts', () => {
    it('removes contacts and their checkouts', async () => {
      const loc = await makeLocation('Drawer');
      const item = await makeItem(loc);
      const contact = nextId('contact');
      await exec('INSERT INTO contacts (id, name) VALUES (?, ?);', [contact, 'Sam']);
      await exec('INSERT INTO checkouts (id, item_id, contact_id) VALUES (?, ?, ?);', [
        nextId('co'),
        item,
        contact,
      ]);

      await eraseTargets(['contacts'], { tombstone: false }, ports());

      expect(await count('contacts')).toBe(0);
      expect(await count('checkouts')).toBe(0);
      expect(await count('items')).toBe(1);
    });
  });

  describe('locations', () => {
    it('deletes only empty non-system locations; keeps system + stock-holding ones', async () => {
      const empty = await makeLocation('Empty Shelf');
      const holding = await makeLocation('Busy Shelf');
      await makeItem(holding); // makes `holding` non-empty

      await eraseTargets(['locations'], { tombstone: false }, ports());

      // Empty custom location gone.
      expect(await driver.queryOne('SELECT 1 FROM locations WHERE id = ?;', [empty])).toBeUndefined();
      // Stock-holding custom location kept.
      expect(await driver.queryOne('SELECT 1 FROM locations WHERE id = ?;', [holding])).toBeDefined();
      // System location untouched.
      expect(
        await driver.queryOne('SELECT 1 FROM locations WHERE id = ?;', [UNASSIGNED_LOCATION_ID]),
      ).toBeDefined();
    });

    it('combined [items, locations] also removes the stock-holding location (items go first)', async () => {
      const holding = await makeLocation('Busy Shelf');
      await makeItem(holding);

      await eraseTargets(['items', 'locations'], { tombstone: false, now: 1 }, ports());

      expect(await count('items')).toBe(0);
      expect(await driver.queryOne('SELECT 1 FROM locations WHERE id = ?;', [holding])).toBeUndefined();
    });
  });

  describe('item-history', () => {
    it('advances the prune watermark to now', async () => {
      const loc = await makeLocation('Shelf');
      const item = await makeItem(loc);
      await exec('INSERT INTO item_history (id, item_id, action) VALUES (?, ?, ?);', [
        nextId('hist'),
        item,
        'CREATED',
      ]);

      await eraseTargets(['item-history'], { tombstone: false, now: 7_777 }, ports());

      expect(await count('item_history')).toBe(0);
      const row = await driver.queryOne<{ n: number }>(
        'SELECT history_pruned_before AS n FROM sync_meta WHERE id = 1;',
      );
      expect(Number(row?.n)).toBe(7_777);
    });
  });

  describe('local + sync-links targets', () => {
    it('removes local keys via local.removeItem', async () => {
      const p = ports({ 'gubbins:preferences': '{}', 'gubbins:keep': '1' });
      await eraseTargets(['preferences'], { tombstone: false }, p);
      expect(p.local.getItem('gubbins:preferences')).toBeNull();
      expect(p.local.getItem('gubbins:keep')).toBe('1');
    });

    it('sync-links deletes gubbins-fs, clears tombstones and zeroes the sync cursor', async () => {
      // Seed a tombstone + non-zero sync cursor.
      await exec("INSERT INTO tombstones (table_name, id) VALUES ('items', 'x');");
      await exec(
        'UPDATE sync_meta SET last_sync_timestamp = 99, clock_offset = 5, history_pruned_before = 42 WHERE id = 1;',
      );

      await eraseTargets(['sync-links'], { tombstone: false }, ports());

      expect(await count('tombstones')).toBe(0);
      const meta = await driver.queryOne<{ ls: number; co: number; hp: number }>(
        'SELECT last_sync_timestamp AS ls, clock_offset AS co, history_pruned_before AS hp FROM sync_meta WHERE id = 1;',
      );
      expect(Number(meta?.ls)).toBe(0);
      expect(Number(meta?.co)).toBe(0);
      // history watermark must be left intact.
      expect(Number(meta?.hp)).toBe(42);
      expect(deleteIdb).toHaveBeenCalledWith('gubbins-fs');
    });
  });
});

describe('countTargets', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    seq = 1;
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('counts DB rows for db targets and present keys for local targets', async () => {
    await driver.execute('INSERT INTO locations (id, name, is_system) VALUES (?, ?, 0);', ['l1', 'Shelf']);
    await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
      'i1',
      'Widget',
      'l1',
    ]);
    const local = fakeStorage({ 'gubbins:preferences': '{}' });

    const counts = await countTargets(['items', 'preferences'], { db: driver, local });
    expect(counts.items).toBe(1);
    expect(counts.preferences).toBe(1);
  });
});
