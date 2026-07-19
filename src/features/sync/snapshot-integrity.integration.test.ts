/**
 * Issue #405: a snapshot must be internally foreign-key-consistent, whatever a concurrent
 * write did to it mid-read.
 *
 * `buildLocalSnapshot` reads each table with its own unisolated query, and `SYNC_TABLES` is
 * ordered parents-first, so a row created between the read of its parent's table and the read
 * of its own lands in the snapshot with its parent missing. Issue #204 made each *individual*
 * table read self-correcting; it did nothing for consistency *across* tables.
 *
 * That matters far more than it sounds, and the first test here is what proves why: a restore
 * applies the whole snapshot in one transaction, and SQLite's `OR IGNORE` / `ON CONFLICT`
 * resolution does **not** extend to FOREIGN KEY constraints. So a single orphaned row does not
 * cost that row — it aborts the transaction and costs the entire restore.
 *
 * These run over `node:sqlite` with the real migrations and `PRAGMA foreign_keys=ON`, because
 * the claim being tested is about what the database actually does, not about our logic above it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { buildLocalSnapshot, restoreSnapshot } from './snapshot';
import type { SyncSnapshot } from './types';
import type { IDatabaseDriver } from '@/db/rpc/driver';

/** Seed one item and one tag, linked — the baseline every test starts from. */
async function seed(driver: MemoryDriver): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    'i-1',
    'Real item',
    UNASSIGNED_LOCATION_ID,
    1,
  ]);
  await driver.execute('INSERT INTO tags (id, name, updated_at) VALUES (?, ?, ?);', ['t-1', 'Real tag', 1]);
  await driver.execute('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);', ['i-1', 't-1']);
}

describe('snapshot foreign-key safety (issue #405)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await seed(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('an orphan edge aborts the entire restore, not just that edge', async () => {
    // The premise the whole fix rests on. Hand-build the snapshot a torn read would produce —
    // a valid edge plus one whose item is absent — and confirm the damage is total.
    const snapshot = await buildLocalSnapshot(driver, 1);
    const torn: SyncSnapshot = {
      ...snapshot,
      itemTags: [...snapshot.itemTags, { itemId: 'i-ghost', tagId: 't-1' }],
    };

    const target = createMemoryDriver();
    try {
      await runMigrations(target, migrations);
      await expect(restoreSnapshot(target, torn)).rejects.toThrow(/FOREIGN KEY/i);
      // Not "the ghost edge was skipped" — nothing at all survived. `OR IGNORE` covers UNIQUE /
      // NOT NULL / CHECK / PRIMARY KEY, but never a foreign key, so the whole batch rolled back.
      const rows = await target.query<{ c: number }>('SELECT COUNT(*) AS c FROM items;');
      expect(Number(rows[0]?.c)).toBe(0);
    } finally {
      await target.close();
    }
  });

  it('drops an edge whose item is created after the items read', async () => {
    // The real torn read: `items` is read, *then* an item and its tag link are written, *then*
    // `item_tags` is read. The edge is in the snapshot; its parent never was.
    const snapshot = await buildLocalSnapshot(afterItemsRead(driver, addLinkedItem), 1);

    const itemIds = new Set((snapshot.tables.items ?? []).map((row) => String(row.id)));
    expect(itemIds.has('i-late')).toBe(false);
    expect(snapshot.itemTags).not.toContainEqual({ itemId: 'i-late', tagId: 't-1' });
    // The pre-existing edge is untouched — the repair drops orphans, not the healthy set.
    expect(snapshot.itemTags).toContainEqual({ itemId: 'i-1', tagId: 't-1' });
  });

  it('produces a snapshot that restores cleanly despite the torn read', async () => {
    const snapshot = await buildLocalSnapshot(afterItemsRead(driver, addLinkedItem), 1);

    const target = createMemoryDriver();
    try {
      await runMigrations(target, migrations);
      await expect(restoreSnapshot(target, snapshot)).resolves.toBeUndefined();
      const rows = await target.query<{ id: string }>('SELECT id FROM items ORDER BY id;');
      expect(rows.map((r) => r.id)).toEqual(['i-1']);
    } finally {
      await target.close();
    }
  });

  it('drops a child row whose non-nullable parent is absent', async () => {
    // Not only the M:N edges: every FK_REFS reference has the same window. `item_images.item_id`
    // is NOT NULL / ON DELETE CASCADE, so the row cannot outlive an absent parent.
    const snapshot = await buildLocalSnapshot(
      afterItemsRead(driver, async (d) => {
        await d.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
          'i-late',
          'Late item',
          UNASSIGNED_LOCATION_ID,
          1,
        ]);
        await d.execute(
          'INSERT INTO item_images (id, item_id, full_res_opfs_path, updated_at) VALUES (?, ?, ?, ?);',
          ['img-1', 'i-late', 'images/img-1.webp', 1],
        );
      }),
      1,
    );

    expect((snapshot.tables.item_images ?? []).map((row) => String(row.id))).toEqual([]);
  });

  it('keeps a row whose absent parent is referenced nullably, clearing the link', async () => {
    // The mirror case: `items.category_id` is ON DELETE SET NULL, so an item whose category was
    // created mid-read keeps its row and loses only the reference. Dropping the item instead
    // would lose real inventory over a category that exists perfectly well locally.
    await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
      'i-2',
      'Categorised later',
      UNASSIGNED_LOCATION_ID,
      1,
    ]);
    const snapshot = await buildLocalSnapshot(
      afterCategoriesRead(driver, async (d) => {
        await d.execute('INSERT INTO categories (id, name, updated_at) VALUES (?, ?, ?);', [
          'c-late',
          'Late category',
          1,
        ]);
        await d.execute('UPDATE items SET category_id = ? WHERE id = ?;', ['c-late', 'i-2']);
      }),
      1,
    );

    const item = (snapshot.tables.items ?? []).find((row) => String(row.id) === 'i-2');
    expect(item).toBeDefined();
    expect(item?.category_id).toBeNull();
  });
});

/** Insert an item and link it to the existing tag — the write that lands mid-snapshot. */
async function addLinkedItem(d: MemoryDriver): Promise<void> {
  await d.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    'i-late',
    'Late item',
    UNASSIGNED_LOCATION_ID,
    1,
  ]);
  await d.execute('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);', ['i-late', 't-1']);
}

/** A driver that runs `intrude` once, right after the read of `table` — the peer write mid-snapshot. */
function afterTableRead(driver: MemoryDriver, table: string, intrude: (d: MemoryDriver) => Promise<void>) {
  let fired = false;
  const query: IDatabaseDriver['query'] = async (sql, params) => {
    const rows = await driver.query(sql, params);
    if (!fired && sql.includes(`FROM ${table} `)) {
      fired = true;
      await intrude(driver);
    }
    return rows as never;
  };
  return new Proxy(driver, {
    get: (target, prop, receiver) =>
      prop === 'query' ? query : Reflect.get(target, prop, receiver as unknown as object),
  }) as unknown as IDatabaseDriver;
}

const afterItemsRead = (d: MemoryDriver, intrude: (d: MemoryDriver) => Promise<void>) =>
  afterTableRead(d, 'items', intrude);
const afterCategoriesRead = (d: MemoryDriver, intrude: (d: MemoryDriver) => Promise<void>) =>
  afterTableRead(d, 'categories', intrude);
