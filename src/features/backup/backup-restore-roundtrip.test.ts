/**
 * End-to-end proof for issue #152: a backup taken with "include removed items" **off** must
 * still restore onto a device that has never seen the excluded items.
 *
 * The unit tests around `filterSnapshot` assert the shape of the filtered snapshot; this one
 * asserts the thing the user actually cares about — that the resulting file imports at all.
 * `restoreSnapshot` applies everything in a single transaction against a database with
 * foreign keys enforced, so one dangling reference aborts the *entire* restore, not just the
 * offending row. Only a real driver catches that.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { buildLocalSnapshot, restoreSnapshot } from '@/features/sync/snapshot';
import { filterSnapshot } from './backup-format';

async function makeDevice(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return driver;
}

/** Seed the exact scenario from the issue: a removed item cross-linked to a kept one. */
async function seedSourceDevice(driver: MemoryDriver): Promise<void> {
  await driver.execute(
    `INSERT INTO items (id, name, is_active, quantity, location_id) VALUES
       ('item-a', 'Retired drill', 0, 0, ?),
       ('item-b', 'Drill bit set', 1, 1, ?);`,
    [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_ID],
  );
  await driver.execute(
    `INSERT INTO item_relations (id, from_item_id, to_item_id, kind) VALUES
       ('item-a|item-b|works_with', 'item-a', 'item-b', 'works_with');`,
  );
}

describe('backup round-trip with removed items excluded (issue #152)', () => {
  let source: MemoryDriver;
  let target: MemoryDriver;

  beforeEach(async () => {
    source = await makeDevice();
    target = await makeDevice();
    await seedSourceDevice(source);
  });

  it('restores onto a device that has never seen the excluded item', async () => {
    const snapshot = await buildLocalSnapshot(source);
    const filtered = filterSnapshot(snapshot, { includeHistory: true, includeRemovedItems: false });

    await expect(restoreSnapshot(target, filtered)).resolves.toBeUndefined();

    const items = await target.query<{ id: string }>('SELECT id FROM items ORDER BY id;');
    expect(items.map((r) => r.id)).toEqual(['item-b']);
    // The relation went with the item it pointed at, rather than dangling.
    const relations = await target.query('SELECT id FROM item_relations;');
    expect(relations).toEqual([]);
  });

  it('still carries the relation when removed items are included', async () => {
    const snapshot = await buildLocalSnapshot(source);
    const filtered = filterSnapshot(snapshot, { includeHistory: true, includeRemovedItems: true });

    await restoreSnapshot(target, filtered);

    const relations = await target.query<{ id: string }>('SELECT id FROM item_relations;');
    expect(relations.map((r) => r.id)).toEqual(['item-a|item-b|works_with']);
  });
});
