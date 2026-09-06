import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { runSnapshotMerge, type SnapshotMergeRequest } from './merge';
import { buildLocalSnapshot } from './snapshot';

/**
 * A settled gauge is left alone by a sync, and a moved one is still put back (issue #869).
 *
 * The §7.3 gauge correction used to write its replayed value back unconditionally. SQLite's
 * auto-stamp trigger fires once per *matched* row, not per changed value, so writing the reading
 * a row already held still moved `updated_at` — on every sync, on both devices, for ever. The
 * inflated stamp then beat a genuine edit still in flight from the other device under
 * Last-Write-Wins, discarding its name, notes, price and location with no conflict recorded.
 *
 * Only the *write* is guarded. Withholding the resolution instead looks equivalent and is not:
 * the correction runs after the Last-Write-Wins upserts, which write every column of the winning
 * row, so it is also what puts this device's own consumption back when a peer's `items` row wins
 * for a reason that has nothing to do with the gauge. The last two cases here hold those two
 * halves apart, and with them the asymmetry `reconcileGauges` documents against `reconcileStock`.
 * That peer edit overwrites a discrete item's `quantity` just the same — but a count has a ledger
 * of its own, and issue #189's re-derive rebuilds it from the `item_stock` rows the edit could not
 * reach. A gauge's reading has no second home, which is why the stock pass may skip where this
 * one may not.
 *
 * Real SQLite, the real triggers and the real merge path throughout: the stamp behaviour is the
 * half a plan-shaped assertion cannot show.
 */
describe('a settled gauge does not churn its timestamp (issue #869)', () => {
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

  async function row(driver: MemoryDriver, itemId: string) {
    return driver.queryOne<{ name: string; updated_at: number; current_net_value: number }>(
      'SELECT name, updated_at, current_net_value FROM items WHERE id = ?;',
      [itemId],
    );
  }

  /**
   * A gauge both devices hold, with a complete ledger on each — the well-formed case, which is
   * exactly the one that churned. A gauge whose ledger cannot be replayed falls back to
   * Last-Write-Wins and never reaches the correction at all.
   */
  async function convergedGauge(): Promise<string> {
    const item = await itemsA.create({
      name: 'Resin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 0 },
    });
    await itemsA.adjustGauge(item.id, { delta: -55 });
    await sync(a, b);
    await sync(b, a);
    return item.id;
  }

  it('leaves updated_at where it was across repeated idle syncs', async () => {
    const id = await convergedGauge();
    const before = { a: (await row(a, id))!.updated_at, b: (await row(b, id))!.updated_at };

    for (let i = 0; i < 6; i += 1) {
      await sync(a, b);
      await sync(b, a);
    }

    const after = { a: (await row(a, id))!.updated_at, b: (await row(b, id))!.updated_at };
    expect(after).toEqual(before);
    expect((await row(a, id))!.current_net_value).toBe(945);
    expect((await row(b, id))!.current_net_value).toBe(945);
  });

  it('keeps a rename made on the other device while a stale sync runs', async () => {
    const id = await convergedGauge();

    // B renames the gauge. A then syncs against a remote that predates the rename — the
    // ordinary offline-then-reconnect order, and the window the churn turned into data loss.
    const stale = await buildLocalSnapshot(b);
    await itemsB.update(id, { name: 'Grey Resin' });
    await runSnapshotMerge(a, request({ remote: stale }));

    // A's stamp must not have moved past B's edit, or A's stale name wins the next merge.
    expect((await row(a, id))!.updated_at).toBeLessThan((await row(b, id))!.updated_at);

    await sync(b, a);
    expect((await row(a, id))!.name).toBe('Grey Resin');
  });

  it('does not re-stamp when a real correction lands back on the value already stored', async () => {
    const id = await convergedGauge();

    // B consumes 30 g and puts it straight back. Both movements are new to A, so the correction
    // is emitted — but it replays to 945, which is what A's row already reads. The write must
    // still match no row: an auto-stamp here would push A's stamp past B's own edit, and A would
    // then win Last-Write-Wins against the device that actually did the work.
    await itemsB.adjustGauge(id, { delta: -30 });
    await itemsB.adjustGauge(id, { delta: 30 });
    await sync(b, a);

    const after = (await row(a, id))!;
    expect(after.current_net_value).toBe(945);
    // A took B's row wholesale under LWW, so it carries B's stamp — and nothing later.
    expect(after.updated_at).toBe((await row(b, id))!.updated_at);
  });

  it('keeps this device’s consumption when the peer wins on an edit that is not about the gauge', async () => {
    const id = await convergedGauge();

    // A consumes 30 g offline. B, which has not touched the gauge at all, renames the item — so
    // B's `items` row is the newer one, and the merge upsert writes every one of its columns,
    // `current_net_value` included. B's ledger is a strict subset of A's, so a reconcile-side
    // skip would look justified; it would in fact discard A's 30 g, permanently and in silence.
    await itemsA.adjustGauge(id, { delta: -30 });
    await itemsB.update(id, { name: 'Grey Resin' });
    await sync(b, a);

    const after = (await row(a, id))!;
    expect(after.name).toBe('Grey Resin');
    expect(after.current_net_value).toBe(915);
  });

  it('a discrete item’s count survives the same edit by a different route', async () => {
    // The asymmetry the gauge pass documents against the stock pass. A count is held in
    // `item_stock` / `stock_batches`, which the peer's `items` edit cannot reach, so issue #189's
    // re-derive rebuilds `items.quantity` from a ledger that is still intact. A gauge's reading is
    // held on the `items` row itself and has no such source to be rebuilt from — the §7.3
    // correction above is the only one it has.
    const loc = await new LocationRepository(a).create({ name: 'Workshop' });
    const item = await itemsA.create({ name: 'Bracket', quantity: 10, locationId: loc.id });
    await sync(a, b);
    await sync(b, a);

    await itemsA.adjustQuantity(item.id, -3);
    await itemsB.update(item.id, { name: 'Steel Bracket' });
    await sync(b, a);

    const after = await a.queryOne<{ name: string; quantity: number }>(
      'SELECT name, quantity FROM items WHERE id = ?;',
      [item.id],
    );
    expect(after!.name).toBe('Steel Bracket');
    expect(Number(after!.quantity)).toBe(7);
  });

  it('still converges a gauge the two devices really did move apart', async () => {
    const id = await convergedGauge();

    // Concurrent consumption on both sides: 1000 − 55 − 30 − 20.
    await itemsA.adjustGauge(id, { delta: -30 });
    await itemsB.adjustGauge(id, { delta: -20 });
    await sync(a, b);
    await sync(b, a);

    expect((await row(a, id))!.current_net_value).toBe(895);
    expect((await row(b, id))!.current_net_value).toBe(895);
  });
});
