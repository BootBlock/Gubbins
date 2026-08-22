/**
 * Issue #602: a snapshot section is emitted in `id` order, and the apply paths order one table
 * against another by its `SYNC_TABLES` index. Neither can order two rows of the *same* table, so a
 * self-referencing row — `locations.parent_id` (a sub-location) or `items.parent_id` (a variant) —
 * whose random UUID sorts before its parent's was written first and aborted the whole merge or
 * restore on `FOREIGN KEY constraint failed`. The delete half had the mirror fault: a peer that
 * removed a sub-location and its parent in one pass could present the parent's tombstone first.
 *
 * Every id here is deliberately inverted (`zzz-` parent, `aaa-` child) so the child sorts first —
 * the condition the existing suites never hit, because they happen to name parents `locX` and
 * children `locY`. Run over `node:sqlite` with the real migrations and foreign keys enabled,
 * because the claim is about what SQLite actually does with the emitted batch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE } from '@/db/repositories/tombstone';
import { reconcile } from './reconcile';
import { applyPlan, buildLocalSnapshot, restoreSnapshot } from './snapshot';
import { runSnapshotMerge } from './merge';
import { buildSchemaDictionary } from './schema-dictionary';
import type { SyncSnapshot } from './types';

const PARENT_LOCATION = 'zzz-parent-location';
const CHILD_LOCATION = 'aaa-child-location';
const BASE_ITEM = 'zzz-base-item';
const VARIANT_ITEM = 'aaa-variant-item';

async function freshDriver(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return driver;
}

function dictionaryFor(driver: MemoryDriver) {
  return buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE]);
}

/** A parent location holding one sub-location whose id sorts *before* it. */
async function seedLocationTree(driver: MemoryDriver): Promise<void> {
  await driver.execute('INSERT INTO locations (id, name, updated_at) VALUES (?, ?, ?);', [
    PARENT_LOCATION,
    'Workshop',
    100,
  ]);
  await driver.execute('INSERT INTO locations (id, name, parent_id, updated_at) VALUES (?, ?, ?, ?);', [
    CHILD_LOCATION,
    'Top shelf',
    PARENT_LOCATION,
    100,
  ]);
}

/** A base item and a variant of it whose id sorts *before* the base's. */
async function seedItemVariant(driver: MemoryDriver): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    BASE_ITEM,
    'Screwdriver',
    PARENT_LOCATION,
    100,
  ]);
  await driver.execute(
    'INSERT INTO items (id, name, location_id, parent_id, updated_at) VALUES (?, ?, ?, ?, ?);',
    [VARIANT_ITEM, 'Screwdriver — PH2', PARENT_LOCATION, BASE_ITEM, 100],
  );
}

/** Build the snapshot a peer holding `seed`'s data would publish. */
async function peerSnapshot(seed: (d: MemoryDriver) => Promise<void>): Promise<SyncSnapshot> {
  const source = await freshDriver();
  try {
    await seed(source);
    return await buildLocalSnapshot(source, 1000);
  } finally {
    await source.close();
  }
}

describe('a self-referencing row applied before its parent (issue #602)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = await freshDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Pull `remote` into the empty local device the way a first sync does. */
  async function merge(remote: SyncSnapshot): Promise<void> {
    const dictionary = await dictionaryFor(driver);
    const local = await buildLocalSnapshot(driver, 1);
    await applyPlan(driver, reconcile(local, remote, { offset: 0, dictionary }), dictionary);
  }

  async function parentOf(table: 'locations' | 'items', id: string): Promise<string | null> {
    const row = await driver.queryOne<{ parent_id: string | null }>(
      `SELECT parent_id FROM ${table} WHERE id = ?;`,
      [id],
    );
    return row?.parent_id ?? null;
  }

  it('merges a location tree whose child id sorts before its parent', async () => {
    await merge(await peerSnapshot(seedLocationTree));

    expect(await parentOf('locations', CHILD_LOCATION)).toBe(PARENT_LOCATION);
  });

  it('merges an item variant whose id sorts before its base item', async () => {
    await merge(
      await peerSnapshot(async (d) => {
        await seedLocationTree(d);
        await seedItemVariant(d);
      }),
    );

    expect(await parentOf('items', VARIANT_ITEM)).toBe(BASE_ITEM);
  });

  it('merges a peer that deleted a sub-location and its parent in one pass', async () => {
    // The delete half is ordered by table index, and both rows are `locations` — so the emitted
    // order follows the ids, and the parent's DELETE runs while its child still references it.
    // These two ids are therefore inverted the *other* way round to the rest of the file: the
    // parent sorts first, which is what puts the delete in the wrong order.
    const deletedParent = 'aaa-parent-location';
    const deletedChild = 'zzz-child-location';
    await driver.execute('INSERT INTO locations (id, name, updated_at) VALUES (?, ?, ?);', [
      deletedParent,
      'Garage',
      100,
    ]);
    await driver.execute('INSERT INTO locations (id, name, parent_id, updated_at) VALUES (?, ?, ?, ?);', [
      deletedChild,
      'Rack',
      deletedParent,
      100,
    ]);
    const empty = await peerSnapshot(async () => {});
    const remote: SyncSnapshot = {
      ...empty,
      tombstones: [
        { tableName: 'locations', id: deletedParent, deletedAt: 900 },
        { tableName: 'locations', id: deletedChild, deletedAt: 900 },
      ],
    };

    await merge(remote);

    const left = await driver.query<{ id: string }>('SELECT id FROM locations WHERE id IN (?, ?);', [
      deletedParent,
      deletedChild,
    ]);
    expect(left).toEqual([]);
  });

  it('restores a backup carrying a location tree with inverted ids', async () => {
    await restoreSnapshot(driver, await peerSnapshot(seedLocationTree));

    expect(await parentOf('locations', CHILD_LOCATION)).toBe(PARENT_LOCATION);
  });

  it('clones a remote snapshot carrying a location tree and an item variant', async () => {
    // The §7.2 tombstone-TTL clone, driven through its real entry point rather than by
    // re-composing the builder here — the destructive "Replace" restore wipes and clones the
    // same statements the same way.
    const remote = await peerSnapshot(async (d) => {
      await seedLocationTree(d);
      await seedItemVariant(d);
    });

    await runSnapshotMerge(driver, {
      mode: 'clone',
      remote,
      offset: 0,
      effectiveNow: 2000,
      lastSyncTimestamp: 2000,
      historyPrunedBefore: 0,
      forceTies: false,
    });

    expect(await parentOf('locations', CHILD_LOCATION)).toBe(PARENT_LOCATION);
    expect(await parentOf('items', VARIANT_ITEM)).toBe(BASE_ITEM);
  });
});
