/**
 * Drift guard (issue #254). `advanceHistoryWatermark` in `erase-targets.ts` says it "mirrors
 * `StorageRepository.pruneHistoryBefore`" — two copies of the §7.6.3-A watermark UPDATE, in two
 * modules, written in SQL, compared by nothing.
 *
 * The watermark is what stops a peer re-importing history the user just destroyed: the reconcile
 * engine refuses any remote `item_history` row older than `history_pruned_before`. So a drift
 * here is silent and one-directional — the erase appears to succeed, and the rows come back on
 * the next sync. Rather than compare the two SQL strings, this drives both against a real
 * `:memory:` database and requires the *state they leave behind* to match, including the
 * monotonic `MAX` that keeps a later, smaller cutoff from winding the watermark back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { StorageRepository } from '@/db/repositories/StorageRepository';
import { eraseTargetById } from './erase-targets';

const NOW = 1_700_000_000_000;

describe('history prune watermark: erase target ↔ StorageRepository (issue #254)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let storage: StorageRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    storage = new StorageRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** The current §7.6.3-A watermark. */
  async function watermark(): Promise<number> {
    const row = await driver.queryOne<{ v: number }>(
      'SELECT history_pruned_before AS v FROM sync_meta WHERE id = 1;',
    );
    return Number(row?.v ?? -1);
  }

  /** Run the Danger-Zone "activity log" target's statements at `now`. */
  async function runEraseTarget(now: number): Promise<void> {
    const target = eraseTargetById('item-history');
    expect(target?.buildStatements).toBeDefined();
    for (const statement of target!.buildStatements!({ tombstone: false, now })) {
      await driver.execute(statement.sql, statement.params);
    }
  }

  it('leaves the watermark at the same value for the same instant', async () => {
    await items.create({ name: 'Logged' }); // logs a CREATED history row

    await runEraseTarget(NOW);
    const afterErase = await watermark();

    // Reset and take the other path to the same instant.
    await driver.execute('UPDATE sync_meta SET history_pruned_before = 0 WHERE id = 1;');
    await storage.pruneHistoryBefore(NOW);

    expect(await watermark()).toBe(afterErase);
    expect(afterErase).toBe(NOW);
  });

  it('advances the watermark monotonically on both paths', async () => {
    await storage.pruneHistoryBefore(NOW);
    // A later run at an *earlier* cutoff must not wind the watermark back on either path —
    // history already declared unimportable cannot become importable again.
    await storage.pruneHistoryBefore(NOW - 5_000);
    expect(await watermark()).toBe(NOW);

    await runEraseTarget(NOW - 5_000);
    expect(await watermark()).toBe(NOW);
  });

  it('clears the rows each path claims to, and only those', async () => {
    const item = await items.create({ name: 'Logged' });
    // `create` logs a CREATED row stamped with the real clock, which sits far past the fixed
    // NOW used here. Clear it so the three seeded rows are the only ones under test.
    await driver.execute('DELETE FROM item_history;');
    // The last row is stamped *after* the instant the erase target is later run at, so a
    // hypothetical erase that pruned by cutoff rather than wholesale would leave it behind.
    // Without that row the two behaviours are indistinguishable and the erase half of this
    // test asserts nothing.
    for (const createdAt of [NOW - 10_000, NOW - 1_000, NOW + 1_000, NOW + 5_000]) {
      await driver.execute(
        'INSERT INTO item_history (id, item_id, action, created_at) VALUES (?, ?, ?, ?);',
        [crypto.randomUUID(), item.id, 'QUANTITY_CHANGE', createdAt],
      );
    }

    // The repository prunes strictly older than the cutoff; the two newer rows survive.
    await storage.pruneHistoryBefore(NOW);
    const left = await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM item_history;');
    expect(Number(left[0]!.n)).toBe(2);

    // The Danger-Zone target clears the log wholesale — including the row stamped after the
    // instant it runs at, which a cutoff-based delete would have spared.
    await runEraseTarget(NOW + 2_000);
    const none = await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM item_history;');
    expect(Number(none[0]!.n)).toBe(0);
    expect(await watermark()).toBe(NOW + 2_000);
  });
});
