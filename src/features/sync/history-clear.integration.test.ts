import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { runSnapshotMerge, type SnapshotMergeRequest } from './merge';
import { buildLocalSnapshot } from './snapshot';

/**
 * Clearing an item's Activity Log, end-to-end across two devices (issue #620).
 *
 * The unit tests prove the reconcile engine *plans* the right thing; this proves the plan
 * actually lands, against real SQLite and the real merge path. It is the test that matters
 * for this feature: `item_history` reconciles by union-by-id, so a clear that is only a local
 * DELETE looks to a peer exactly like a row the peer should hand back — the feature would
 * appear to work and quietly undo itself on the next sync.
 */
describe('Activity Log clear across devices (issue #620)', () => {
  let a: MemoryDriver;
  let b: MemoryDriver;
  let itemsA: ItemRepository;
  let itemsB: ItemRepository;

  beforeEach(async () => {
    a = createMemoryDriver();
    b = createMemoryDriver();
    await runMigrations(a, migrations);
    await runMigrations(b, migrations);
    itemsA = new ItemRepository(a);
    itemsB = new ItemRepository(b);
  });

  afterEach(async () => {
    await a.close();
    await b.close();
  });

  function request(overrides: Partial<SnapshotMergeRequest> = {}): SnapshotMergeRequest {
    return {
      mode: 'delta',
      remote: null,
      offset: 0,
      effectiveNow: 1_000_000,
      lastSyncTimestamp: 0,
      historyPrunedBefore: 0,
      forceTies: false,
      ...overrides,
    };
  }

  /** Merge `from`'s current state into `into`, as a delta sync between two peers. */
  async function sync(from: MemoryDriver, into: MemoryDriver): Promise<void> {
    const remote = await buildLocalSnapshot(from);
    await runSnapshotMerge(into, request({ remote }));
  }

  /** The actions in one item's ledger on `driver`, oldest first. */
  async function ledger(driver: MemoryDriver, itemId: string): Promise<string[]> {
    const rows = await driver.query<{ action: string }>(
      'SELECT action FROM item_history WHERE item_id = ? ORDER BY created_at ASC, rowid ASC;',
      [itemId],
    );
    return rows.map((r) => r.action);
  }

  it('does not hand the cleared entries back on the next sync', async () => {
    const item = await itemsA.create({ name: 'Filament' });
    await itemsA.update(item.id, { name: 'PLA Filament' });
    // Both devices now hold the full ledger. Sorted: the two entries land in the same
    // millisecond, so their order on the peer is the union's insertion order, not the clock's.
    await sync(a, b);
    expect((await ledger(b, item.id)).sort()).toEqual(['CREATED', 'RENAMED']);

    await itemsA.clearHistory(item.id, 'Ada');
    expect(await ledger(a, item.id)).toEqual(['HISTORY_CLEARED']);

    // The peer syncs back what it still holds — the cleared era must not return...
    await sync(b, a);
    expect(await ledger(a, item.id)).toEqual(['HISTORY_CLEARED']);
    // ...and the clear propagates the other way, emptying the peer's copy too.
    await sync(a, b);
    expect(await ledger(b, item.id)).toEqual(['HISTORY_CLEARED']);
  });

  it('keeps what the peer recorded after the clear', async () => {
    const item = await itemsA.create({ name: 'Bolts', quantity: 10 });
    await sync(a, b);
    await itemsA.clearHistory(item.id, 'Ada');

    // The peer goes on using the item after the clear instant.
    await itemsB.adjustQuantity(item.id, 5);
    await sync(b, a);

    // The clear removed the past, not the future: the peer's later movement is kept.
    expect(await ledger(a, item.id)).toEqual(['HISTORY_CLEARED', 'QUANTITY_CHANGE']);
  });

  it('leaves the item and every other item’s ledger untouched', async () => {
    const cleared = await itemsA.create({ name: 'Cleared', quantity: 4 });
    const kept = await itemsA.create({ name: 'Kept' });
    await sync(a, b);

    await itemsA.clearHistory(cleared.id, 'Ada');
    await sync(a, b);

    expect(await ledger(b, kept.id)).toEqual(['CREATED']);
    const row = await b.queryOne<{ name: string; quantity: number }>(
      'SELECT name, quantity FROM items WHERE id = ?;',
      [cleared.id],
    );
    expect(row?.name).toBe('Cleared');
    expect(Number(row?.quantity)).toBe(4);
  });

  it('leaves a gauge reading where it was, rather than reporting it full again', async () => {
    // The ledger is not only the audit trail: a gauge's `GAUGE_UPDATE` deltas are what §7.3
    // reconciliation replays to reconstruct its value. Clearing them without care converges both
    // devices on `gross + 0` — a nearly-empty bottle that reports itself full, permanently.
    const item = await itemsA.create({
      name: 'Resin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 0 },
    });
    await itemsA.adjustGauge(item.id, { delta: -600 });
    await sync(a, b);

    await itemsA.clearHistory(item.id, 'Ada');
    // Several rounds: the clear propagates on the first, and the replay that would refill the
    // gauge only becomes possible once both ledgers are empty of deltas.
    await sync(b, a);
    await sync(a, b);
    await sync(b, a);
    await sync(a, b);

    const netValue = async (driver: MemoryDriver) =>
      Number(
        (
          await driver.queryOne<{ v: number }>('SELECT current_net_value AS v FROM items WHERE id = ?;', [
            item.id,
          ])
        )?.v,
      );
    expect(await netValue(a)).toBe(400);
    expect(await netValue(b)).toBe(400);
  });

  it('survives adopting the peer wholesale, not just a delta merge', async () => {
    const item = await itemsA.create({ name: 'Wholesale' });
    await itemsA.update(item.id, { name: 'Wholesale v2' });
    await sync(a, b);
    await itemsA.clearHistory(item.id, 'Ada');

    // `clone` is the path a device takes when it cannot diff against the remote — it wipes and
    // re-clones, then salvages local work back on top. The clear rides in that salvage.
    const remote = await buildLocalSnapshot(b);
    await runSnapshotMerge(a, request({ mode: 'clone', remote }));

    expect(await ledger(a, item.id)).toEqual(['HISTORY_CLEARED']);
  });
});
