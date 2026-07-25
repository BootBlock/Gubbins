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
import { allSettingsGroups } from './settings-groups';

/** Every settings group ticked — the shape `filterSnapshot` needs for the settings-row narrowing. */
const ALL_SETTINGS = { includeSettings: true, settingGroups: allSettingsGroups(true) } as const;

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
    const filtered = filterSnapshot(snapshot, {
      includeHistory: true,
      includeRemovedItems: false,
      ...ALL_SETTINGS,
    });

    await expect(restoreSnapshot(target, filtered)).resolves.toBeUndefined();

    const items = await target.query<{ id: string }>('SELECT id FROM items ORDER BY id;');
    expect(items.map((r) => r.id)).toEqual(['item-b']);
    // The relation went with the item it pointed at, rather than dangling.
    const relations = await target.query('SELECT id FROM item_relations;');
    expect(relations).toEqual([]);
  });

  it("rebuilds the target's per-location item counts (issue #167)", async () => {
    // The sidebar's location counts come from a trigger-maintained cache, not an aggregate, so
    // a restore has to leave it agreeing with the items it actually landed. The target starts
    // with an item of its own — a restore merges rather than replaces — so the cache has to
    // survive rows arriving alongside rows already there, not just a fill of an empty table.
    await target.execute(
      `INSERT INTO items (id, name, is_active, quantity, location_id) VALUES ('stale', 'Gone', 1, 1, ?);`,
      [UNASSIGNED_LOCATION_ID],
    );

    const snapshot = await buildLocalSnapshot(source);
    await restoreSnapshot(
      target,
      filterSnapshot(snapshot, { includeHistory: true, includeRemovedItems: true, ...ALL_SETTINGS }),
    );

    const counts = await target.query<{ location_id: string; item_count: number }>(
      'SELECT location_id, item_count FROM location_item_counts ORDER BY location_id;',
    );
    const truth = await target.query<{ location_id: string; n: number }>(
      'SELECT location_id, COUNT(*) AS n FROM items WHERE is_active = 1 GROUP BY location_id ORDER BY location_id;',
    );
    expect(counts.filter((c) => c.item_count > 0)).toEqual(
      truth.map((t) => ({ location_id: t.location_id, item_count: t.n })),
    );
    // Specifically: the target's own active item plus the restored active one — and the
    // restored *inactive* one counted by neither.
    expect(truth).toEqual([{ location_id: UNASSIGNED_LOCATION_ID, n: 2 }]);
  });

  it('still carries the relation when removed items are included', async () => {
    const snapshot = await buildLocalSnapshot(source);
    const filtered = filterSnapshot(snapshot, {
      includeHistory: true,
      includeRemovedItems: true,
      ...ALL_SETTINGS,
    });

    await restoreSnapshot(target, filtered);

    const relations = await target.query<{ id: string }>('SELECT id FROM item_relations;');
    expect(relations.map((r) => r.id)).toEqual(['item-a|item-b|works_with']);
  });
});
