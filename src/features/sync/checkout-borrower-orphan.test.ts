/**
 * Issue #404: a checkout borrowed against a project or a location, whose borrower a peer deleted.
 *
 * The borrower is a tagged union — a loan targets exactly one of a contact, a project or a
 * location, and all three columns are `ON DELETE CASCADE` under a
 * `CHECK ((contact_id IS NOT NULL) + (project_id IS NOT NULL) + (location_id IS NOT NULL) = 1)`.
 * `FK_REFS` guarded only the contact arm, so the other two dangled: device A lends an item to a
 * project, device B deletes that project, and B's next merge carries A's checkout back in as an
 * upsert against a project row that no longer exists. `ON CONFLICT` does not extend to FOREIGN
 * KEY, so that one orphan aborts the whole atomic merge rather than costing that row.
 *
 * The repair is the contact arm's: drop the loan. Nulling the column is not even available — the
 * XOR CHECK forbids a checkout with no borrower — and every borrower delete returns the target's
 * open loans first (`planCheckInAllForTarget`), so the deleting device has already restored the
 * stock and closed the loan before the cascade takes the row.
 *
 * Driven over `node:sqlite` with the real migrations and foreign keys enabled, because the claim
 * is about what SQLite actually does with the emitted batch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE } from '@/db/repositories/tombstone';
import { reconcile } from './reconcile';
import { applyPlan, buildLocalSnapshot, UNASSIGNED_LOCATION_ID } from './snapshot';
import { buildSchemaDictionary } from './schema-dictionary';
import type { SyncSnapshot } from './types';

const ITEM_ID = 'item-torque-wrench';
const CHECKOUT_ID = 'loan-wrench-to-borrower';
const PROJECT_ID = 'proj-henderson-job';
const LOCATION_ID = 'loc-the-van';

type Borrower = 'project' | 'location';

const borrowerColumn = (borrower: Borrower) => (borrower === 'project' ? 'project_id' : 'location_id');
const borrowerId = (borrower: Borrower) => (borrower === 'project' ? PROJECT_ID : LOCATION_ID);

async function freshDriver(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return driver;
}

function dictionaryFor(driver: MemoryDriver) {
  return buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE]);
}

/** The item both devices hold, and the borrower row the loan targets. */
async function seedBorrower(driver: MemoryDriver, borrower: Borrower): Promise<void> {
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    ITEM_ID,
    'Torque wrench',
    UNASSIGNED_LOCATION_ID,
    100,
  ]);
  if (borrower === 'project') {
    await driver.execute('INSERT INTO projects (id, name, updated_at) VALUES (?, ?, ?);', [
      PROJECT_ID,
      'Henderson job',
      100,
    ]);
  } else {
    await driver.execute('INSERT INTO locations (id, name, updated_at) VALUES (?, ?, ?);', [
      LOCATION_ID,
      'The van',
      100,
    ]);
  }
}

/** Device A: the peer that still holds the loan, and publishes it. */
async function peerSnapshot(borrower: Borrower): Promise<SyncSnapshot> {
  const source = await freshDriver();
  try {
    await seedBorrower(source, borrower);
    await source.execute(
      `INSERT INTO checkouts (id, item_id, ${borrowerColumn(borrower)}, quantity, checked_out_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [CHECKOUT_ID, ITEM_ID, borrowerId(borrower), 1, 100, 100],
    );
    return await buildLocalSnapshot(source, 1000);
  } finally {
    await source.close();
  }
}

describe('a checkout whose project or location borrower did not survive a merge (issue #404)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = await freshDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  for (const borrower of ['project', 'location'] as const) {
    // Device B: held the same borrower, then deleted it. The cascade took its own copy of the
    // loan and only the borrower's tombstone is recorded (§7.2), so the peer still offers the
    // orphaned checkout back.
    async function deleteBorrowerLocally(): Promise<void> {
      await seedBorrower(driver, borrower);
      const table = borrower === 'project' ? 'projects' : 'locations';
      await driver.transaction([
        { sql: `DELETE FROM ${table} WHERE id = ?;`, params: [borrowerId(borrower)] },
        {
          sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
          params: [table, borrowerId(borrower), 900],
        },
      ]);
    }

    it(`applies the merge instead of tripping the foreign key (${borrower} borrower)`, async () => {
      await deleteBorrowerLocally();
      const dictionary = await dictionaryFor(driver);
      const local = await buildLocalSnapshot(driver, 1);
      const plan = reconcile(local, await peerSnapshot(borrower), { offset: 0, dictionary });

      // The guard drops the orphan before the apply; without it this rejects the whole batch.
      expect(plan.localUpserts.some((u) => u.table === 'checkouts')).toBe(false);
      await applyPlan(driver, plan, dictionary);

      const row = await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM checkouts;');
      expect(row?.n).toBe(0);
      // The item is untouched — only the loan died with its borrower.
      const item = await driver.queryOne<{ id: string }>('SELECT id FROM items WHERE id = ?;', [ITEM_ID]);
      expect(item?.id).toBe(ITEM_ID);
    });

    it(`keeps the loan when the ${borrower} borrower survives`, async () => {
      await seedBorrower(driver, borrower);
      const dictionary = await dictionaryFor(driver);
      const local = await buildLocalSnapshot(driver, 1);
      const plan = reconcile(local, await peerSnapshot(borrower), { offset: 0, dictionary });

      await applyPlan(driver, plan, dictionary);

      const row = await driver.queryOne<{ borrower: string | null }>(
        `SELECT ${borrowerColumn(borrower)} AS borrower FROM checkouts WHERE id = ?;`,
        [CHECKOUT_ID],
      );
      expect(row?.borrower).toBe(borrowerId(borrower));
    });
  }
});
