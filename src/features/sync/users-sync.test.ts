/**
 * Users, roles and attribution across a sync (issue #79, phase 1).
 *
 * These cover the two ways the new protected rows can break the *whole* merge rather than
 * just themselves: a wipe that trips a `RAISE(ABORT)` delete trigger aborts the entire clone
 * transaction, and a retired user drags this device's ledger attribution away with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  ADMIN_USER_ID,
  ITEM_HISTORY_TABLE,
  SYNC_TABLES,
  SYSTEM_USER_ID,
  UNASSIGNED_LOCATION_ID,
} from '@/db/repositories';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { UserRepository } from '@/db/repositories/UserRepository';
import { applyPlan, buildCloneStatements, buildLocalSnapshot } from './snapshot';
import { buildSchemaDictionary } from './schema-dictionary';
import type { ReconciliationPlan } from './types';

const EMPTY_PLAN: ReconciliationPlan = {
  localUpserts: [],
  localDeletes: [],
  gaugeResolutions: [],
  reparented: [],
  rejectedCycles: [],
  serialisedLoansClosed: [],
  collisions: [],
  historyInserts: [],
  itemTagUpserts: [],
  itemTagDeletes: [],
  locationTagUpserts: [],
  locationTagDeletes: [],
  itemRegionUpserts: [],
  itemRegionDeletes: [],
  conflicts: [],
};

describe('users + roles across a sync', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('excludes the built-in principals from the snapshot, since every device seeds them', async () => {
    const users = new UserRepository(driver);
    await users.create({ username: 'sam' });

    const snapshot = await buildLocalSnapshot(driver);

    // A remote UPSERT of System or Admin would trip their protective triggers.
    expect(snapshot.tables.users?.map((r) => r.username)).toEqual(['sam']);
  });

  it('wipes for a clone without tripping the protected-row triggers', async () => {
    const users = new UserRepository(driver);
    await users.create({ username: 'sam' });
    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const remote = await buildLocalSnapshot(driver);

    // The whole point: this must not abort. A bare `DELETE FROM users` would raise
    // "The built-in System and Admin users cannot be deleted." and roll the clone back.
    await driver.transaction(buildCloneStatements(remote, dictionary));

    const rows = await driver.query<{ id: string }>('SELECT id FROM users ORDER BY id;');
    expect(rows.map((r) => r.id)).toContain(SYSTEM_USER_ID);
    expect(rows.map((r) => r.id)).toContain(ADMIN_USER_ID);
  });

  it("re-points a retired user's local ledger rows at the winner, not at System", async () => {
    // Both devices independently created a "sam"; this device's row loses the username.
    const users = new UserRepository(driver);
    const localSam = await users.create({ username: 'sam' });
    const items = new ItemRepository(driver, { resolveActor: () => localSam.id });
    const item = await items.create({ name: 'Drill', locationId: UNASSIGNED_LOCATION_ID });

    const winnerId = 'u-remote-sam';
    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    await applyPlan(
      driver,
      {
        ...EMPTY_PLAN,
        localUpserts: [
          {
            table: 'users',
            row: {
              id: winnerId,
              username: 'sam',
              display_name: 'Sam',
              kind: 'normal',
              is_enabled: 1,
              updated_at: 99,
            },
          },
        ],
        collisions: [{ table: 'users', loserId: localSam.id, winnerId, deletedAt: 99 }],
      },
      dictionary,
    );

    const rows = await driver.query<{ actor_user_id: string }>(
      'SELECT actor_user_id FROM item_history WHERE item_id = ?;',
      [item.id],
    );
    // Without the repoint, ON DELETE SET DEFAULT would have written SYSTEM_USER_ID here and
    // this device would have silently lost the attribution it was recording all along.
    expect(rows.map((r) => r.actor_user_id)).toEqual([winnerId]);
  });
});
