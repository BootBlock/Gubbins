/**
 * Aggregate stock-level counting (EI-5/EI-6), over a real migrated database — the counts are a SQL
 * aggregate through the app's own predicates, so a fake repository could no longer decide them.
 *
 * Two regressions these guard:
 *
 *   - Out-of-stock is counted **independently** of low-stock. With the app-default (opt-in, off)
 *     low-stock thresholds, a depleted item carrying no reorder point is still out of stock, even
 *     though it is never "low" — so the published sensor / metric counts match the app's own "Out
 *     of stock" filter rather than sticking at zero.
 *   - The counts cover the **whole** inventory in one round-trip (issue #532). They used to page
 *     hydrated items into JavaScript, 100 at a time and capped at 50,000, which past the cap
 *     published a partial count as though it were the full one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import type { IDatabaseDriver, SqlParams } from '@/db/rpc/driver';
import { countStockLevels } from './inventory-scan.ts';
import { createNodeDriver, type NodeDriver } from './node-driver.ts';

let driver: NodeDriver;

beforeEach(async () => {
  driver = createNodeDriver();
  await runMigrations(driver, migrations);
});

afterEach(async () => {
  await driver.close();
});

/** Wrap a driver so a projection's read round-trips can be counted. */
function countingDriver(inner: IDatabaseDriver): { driver: IDatabaseDriver; reads: () => number } {
  let reads = 0;
  const counting: IDatabaseDriver = {
    async query<TRow>(sql: string, params?: SqlParams): Promise<TRow[]> {
      reads += 1;
      return inner.query<TRow>(sql, params);
    },
    async queryOne<TRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
      reads += 1;
      return inner.queryOne<TRow>(sql, params);
    },
    execute: (sql, params) => inner.execute(sql, params),
    transaction: (statements) => inner.transaction(statements),
    close: () => inner.close(),
  };
  return { driver: counting, reads: () => reads };
}

describe('countStockLevels', () => {
  it('counts low and out-of-stock independently (out-of-stock is not a subset of low)', async () => {
    const items = new ItemRepository(driver);
    // No reorder point, so with the app-default (off) thresholds this is out but never low.
    await items.create({ name: 'Depleted', trackingMode: 'DISCRETE', quantity: 0 });
    await items.create({ name: 'RunningLow', trackingMode: 'DISCRETE', quantity: 2, reorderPoint: 5 });
    await items.create({ name: 'LowAndEmpty', trackingMode: 'DISCRETE', quantity: 0, reorderPoint: 5 });
    await items.create({ name: 'Healthy', trackingMode: 'DISCRETE', quantity: 50, reorderPoint: 5 });
    await items.create({
      name: 'GaugeEmpty',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 0 },
    });

    expect(await countStockLevels(items)).toEqual({ lowStockItems: 2, outOfStockItems: 3 });
  });

  it('excludes items with no bulk stock level, unlimited supply, and soft-deleted rows', async () => {
    const items = new ItemRepository(driver);
    // A SERIALISED item is pinned at quantity 1 by a schema CHECK, so it can never reach the
    // depleted state its mode exclusion guards against; it is here as a row that must not be
    // counted, with the mode exclusion itself covered by the app's predicate parity guard.
    await items.create({ name: 'SerialisedUnit', trackingMode: 'SERIALISED' });
    await items.create({ name: 'UntrackedThing', trackingMode: 'UNTRACKED' });
    await items.create({ name: 'Mains water', trackingMode: 'DISCRETE', quantity: 0, isUnlimited: true });
    // An abstract variant parent holds no stock of its own, even keeping the reorder point it had
    // before it had children — the SSOT predicates exclude it, so the published counts must too.
    const parent = await items.create({
      name: 'Resistor kit',
      trackingMode: 'DISCRETE',
      quantity: 0,
      reorderPoint: 5,
    });
    const child = await items.create({ name: 'Resistor kit 10k', trackingMode: 'DISCRETE', quantity: 40 });
    await items.setParent(child.id, parent.id);
    const deleted = await items.create({ name: 'Old stock', trackingMode: 'DISCRETE', quantity: 0 });
    await items.softDelete(deleted.id);

    expect(await countStockLevels(items)).toEqual({ lowStockItems: 0, outOfStockItems: 0 });
  });

  it('counts the whole inventory in a single read, past any one page of items', async () => {
    const seed = new ItemRepository(driver);
    // Comfortably more than the repository's `MAX_PAGE_SIZE` (100), so a count that only saw one
    // page — as the paged scan this replaced did per round-trip — could not come out right.
    const total = 150;
    for (let i = 0; i < total; i += 1) {
      await seed.create({ name: `Widget ${i}`, trackingMode: 'DISCRETE', quantity: 0, reorderPoint: 5 });
    }

    const counting = countingDriver(driver);
    const counts = await countStockLevels(new ItemRepository(counting.driver));

    expect(counts).toEqual({ lowStockItems: total, outOfStockItems: total });
    // One aggregate, not a walk: this is what removes the cap the counts used to truncate at.
    expect(counting.reads()).toBe(1);
  });
});
