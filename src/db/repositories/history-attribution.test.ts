import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { buildHistoryArchive } from '@/features/storage/triage';
import { ADMIN_USER_ID, SYSTEM_USER_ID } from './constants';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { StorageRepository } from './StorageRepository';
import { UserRepository } from './UserRepository';

/**
 * Attribution survives the read (issue #774).
 *
 * `item_history.actor_user_id` has been NOT NULL, indexed and foreign-keyed since the baseline,
 * and the write path takes the actor as a required argument — but the mapper dropped it, so
 * nothing above the driver could read it back. Two changes by two people were identical in every
 * attributive field the app, the export and the cold-storage archive could see.
 *
 * These drive the **real** reads over a real migrated database rather than checking that a mapper
 * copies a property. The bug was never in one function: the row shape stopped one column short,
 * and every reader inherited the gap. So each read that produces a DTO is exercised, and the
 * archive — the one place where losing it is permanent — is built from a real read.
 */
describe('item history carries who made the change (issue #774)', () => {
  let driver: MemoryDriver;
  let users: UserRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    users = new UserRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** An item created by `actorId`, then renamed by them — two entries, one account. */
  async function seed(actorId: string, name: string): Promise<string> {
    const repo = new ItemRepository(driver, { resolveActor: () => actorId });
    const item = await repo.create({ name, quantity: 1 });
    await repo.update(item.id, { name: `${name} v2` });
    return item.id;
  }

  it('tells two people’s changes to one item apart, through the read the screen uses', async () => {
    const ada = await users.create({ username: 'ada', displayName: 'Ada Okafor' });
    const items = new ItemRepository(driver, { resolveActor: () => ADMIN_USER_ID });
    const item = await items.create({ name: 'Filament' });
    await new ItemRepository(driver, { resolveActor: () => ada.id }).update(item.id, {
      name: 'PLA Filament',
    });

    const entries = (await items.getHistory(item.id)).rows;
    expect(entries).toHaveLength(2);
    // The reproduction in the issue: the raw rows differed, the DTOs did not.
    expect(new Set(entries.map((e) => e.actorUserId))).toEqual(new Set([ADMIN_USER_ID, ada.id]));
    expect(entries.find((e) => e.action === 'RENAMED')?.actorDisplayName).toBe('Ada Okafor');
    expect(entries.find((e) => e.action === 'CREATED')?.actorDisplayName).toBe('Admin');
  });

  it('carries it on the cross-item feed the Activity screen and the bridge read', async () => {
    const ada = await users.create({ username: 'ada', displayName: 'Ada Okafor' });
    await seed(ada.id, 'Filament');

    const feed = await new ItemRepository(driver).getHistoryFeed();
    expect(feed.rows).toHaveLength(2);
    for (const entry of feed.rows) {
      expect(entry.actorUserId).toBe(ada.id);
      expect(entry.actorDisplayName).toBe('Ada Okafor');
    }
  });

  it('carries it on the batched per-item read the vault export uses', async () => {
    const ada = await users.create({ username: 'ada', displayName: 'Ada Okafor' });
    const first = await seed(ada.id, 'Filament');
    const second = await seed(ADMIN_USER_ID, 'Resin');

    const byItem = await new ItemRepository(driver).getHistoryForItems([first, second], 10);
    expect(byItem.get(first)?.map((e) => e.actorDisplayName)).toEqual(['Ada Okafor', 'Ada Okafor']);
    expect(byItem.get(second)?.map((e) => e.actorDisplayName)).toEqual(['Admin', 'Admin']);
  });

  it('keeps an entry whose account cannot be resolved, rather than dropping it', async () => {
    // The reason the actor join is a LEFT join. A restore, or a merge from a peer that has not yet
    // supplied the account, can leave an id pointing at nothing; an inner join would silently
    // remove those entries from every read — losing audit rows, which is the failure this column
    // exists to prevent. Foreign keys are switched off to write the row such a merge would.
    const item = await seed(ADMIN_USER_ID, 'Filament');
    await driver.execute('PRAGMA foreign_keys = OFF;');
    await driver.execute('UPDATE item_history SET actor_user_id = ? WHERE item_id = ?;', [
      'user-from-a-peer',
      item,
    ]);
    await driver.execute('PRAGMA foreign_keys = ON;');

    const entries = (await new ItemRepository(driver).getHistory(item)).rows;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.actorUserId).toBe('user-from-a-peer');
    // Nothing is invented for a name that cannot be looked up.
    expect(entries[0]?.actorDisplayName).toBeNull();
  });

  it('follows a deleted account’s entries to System, name and all', async () => {
    const ada = await users.create({ username: 'ada', displayName: 'Ada Okafor' });
    const item = await seed(ada.id, 'Filament');

    await users.delete(ada.id);

    const entries = (await new ItemRepository(driver).getHistory(item)).rows;
    expect(entries.map((e) => e.actorUserId)).toEqual([SYSTEM_USER_ID, SYSTEM_USER_ID]);
    expect(entries.map((e) => e.actorDisplayName)).toEqual(['System', 'System']);
  });
});

/**
 * The cold-storage archive (§7.6.3 Workflow A) — the only symptom of #774 that was permanent.
 *
 * Storage Triage writes this file and then deletes the rows it holds, advancing a watermark that
 * stops a peer re-supplying them. Whatever the archive omits is gone from the device.
 */
describe('the history archive names who made each change (issue #774)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('carries the actor id and the name it resolved to, for every archived row', async () => {
    const users = new UserRepository(driver);
    const ada = await users.create({ username: 'ada', displayName: 'Ada Okafor' });
    const items = new ItemRepository(driver, { resolveActor: () => ada.id });
    const item = await items.create({ name: 'Filament' });
    await items.update(item.id, { name: 'PLA Filament' });

    // The real read Workflow A loops to completion, and the real archive builder it hands the
    // rows to — the archive is those objects verbatim, so this is the whole chain.
    const cutoff = Date.now() + 60_000;
    const rows = (await new StorageRepository(driver).listHistoryBefore(cutoff, { limit: 100 })).rows;
    expect(rows).toHaveLength(2);

    const archive = JSON.parse(buildHistoryArchive(rows, cutoff, 0)) as {
      rows: { actorUserId: string; actorDisplayName: string | null }[];
    };
    expect(archive.rows.map((r) => r.actorUserId)).toEqual([ada.id, ada.id]);
    expect(archive.rows.map((r) => r.actorDisplayName)).toEqual(['Ada Okafor', 'Ada Okafor']);
  });
});

/**
 * The sibling location ledger (issue #691) already stored the actor and already carried the id
 * into its DTO; what it lacked was the name, and so did every surface that renders it.
 */
describe('location history carries who made the change (issue #774)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('names the actor on both the per-location read and the cross-location feed', async () => {
    const ada = await new UserRepository(driver).create({
      username: 'ada',
      displayName: 'Ada Okafor',
    });
    const locations = new LocationRepository(driver, { resolveActor: () => ada.id });
    const shelf = await locations.create({ name: 'Shelf A' });
    await locations.update(shelf.id, { name: 'Shelf B' });

    const tab = (await locations.getHistory(shelf.id)).rows;
    expect(tab.length).toBeGreaterThan(0);
    expect(tab.every((e) => e.actorUserId === ada.id)).toBe(true);
    expect(tab.every((e) => e.actorDisplayName === 'Ada Okafor')).toBe(true);

    const feed = (await locations.getHistoryFeed({ actions: ['RENAMED'] })).rows;
    expect(feed).toHaveLength(1);
    expect(feed[0]?.actorDisplayName).toBe('Ada Okafor');
  });
});
