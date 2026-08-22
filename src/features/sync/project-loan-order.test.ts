/**
 * Issue #535: a loan can be taken out against a project (`checkouts.project_id`, one arm of the
 * tagged-union borrower), but `checkouts` was listed *before* `projects` in `SYNC_TABLES`. The
 * three apply paths walk that list in index order, and the clone builder wipes every table before
 * it writes — so every project-borrowed loan was written against a guaranteed-empty `projects`.
 *
 * That did not abort, because every one of those batches also runs under
 * `PRAGMA defer_foreign_keys = ON` (issue #602), which postpones the check to COMMIT, where the
 * batch is complete and consistent. The deferral was added for the one shape the list *cannot*
 * express — a self-reference — and it was the only thing standing between this order and a failed
 * clone. It must not double as the reason a plainly wrong order goes unnoticed.
 *
 * So the clone test applies the emitted statements **without** it: what it asserts is that the
 * order alone is sound, and it is the case that fails on the pre-#535 order. The merge test drives
 * `applyPlan`'s real entry point, deferral included — an end-to-end guard that a project loan
 * survives an ordinary sync, not a second proof of the ordering.
 *
 * Both run over `node:sqlite` with the real migrations and foreign keys enabled, because the
 * claim is about what SQLite actually does with the emitted batch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE } from '@/db/repositories/tombstone';
import { reconcile } from './reconcile';
import { applyPlan, buildCloneStatements, buildLocalSnapshot, UNASSIGNED_LOCATION_ID } from './snapshot';
import { buildSchemaDictionary } from './schema-dictionary';
import type { SyncSnapshot } from './types';

const PROJECT_ID = 'proj-henderson-job';
const ITEM_ID = 'item-torque-wrench';
const CHECKOUT_ID = 'loan-wrench-to-job';

async function freshDriver(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return driver;
}

function dictionaryFor(driver: MemoryDriver) {
  return buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE]);
}

/** One item, out on loan to one project — the ordinary combination of two shipped features. */
async function seedProjectLoan(driver: MemoryDriver): Promise<void> {
  await driver.execute('INSERT INTO projects (id, name, updated_at) VALUES (?, ?, ?);', [
    PROJECT_ID,
    'Henderson job',
    100,
  ]);
  await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
    ITEM_ID,
    'Torque wrench',
    UNASSIGNED_LOCATION_ID,
    100,
  ]);
  await driver.execute(
    'INSERT INTO checkouts (id, item_id, project_id, quantity, checked_out_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);',
    [CHECKOUT_ID, ITEM_ID, PROJECT_ID, 1, 100, 100],
  );
}

/** The snapshot a peer holding a project loan would publish. */
async function peerSnapshot(): Promise<SyncSnapshot> {
  const source = await freshDriver();
  try {
    await seedProjectLoan(source);
    return await buildLocalSnapshot(source, 1000);
  } finally {
    await source.close();
  }
}

describe('a loan borrowed against a project (issue #535)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = await freshDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  async function borrowerOf(checkoutId: string): Promise<string | null> {
    const row = await driver.queryOne<{ project_id: string | null }>(
      'SELECT project_id FROM checkouts WHERE id = ?;',
      [checkoutId],
    );
    return row?.project_id ?? null;
  }

  it('clones without the deferred check saving it', async () => {
    // The §7.2 TTL clone and the destructive "Replace" restore share this builder, and it wipes
    // every table first — so the loan is written against a guaranteed-empty `projects` unless the
    // list orders them correctly. Applied bare: no `withDeferredForeignKeys`, no capture guard.
    const dictionary = await dictionaryFor(driver);
    const statements = buildCloneStatements(await peerSnapshot(), dictionary);

    await driver.transaction(statements);

    expect(await borrowerOf(CHECKOUT_ID)).toBe(PROJECT_ID);
  });

  it('merges a peer that created a project and the loan against it in one pass', async () => {
    // The ordinary delta path, driven through `applyPlan` as the engine calls it. Its deferred
    // check means this passes on either order — it guards the feature pairing end to end, and the
    // clone case above is what guards the ordering.
    const dictionary = await dictionaryFor(driver);
    const local = await buildLocalSnapshot(driver, 1);
    const plan = reconcile(local, await peerSnapshot(), { offset: 0, dictionary });

    await applyPlan(driver, plan, dictionary);

    expect(await borrowerOf(CHECKOUT_ID)).toBe(PROJECT_ID);
  });
});
