import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE, SYNC_TABLES } from '@/db/repositories/tombstone';
import { UNTRACKED_BATCH } from '@/db/repositories/stock-batches';
import {
  applyPlan,
  buildLocalSnapshot,
  buildCloneStatements,
  buildSchemaDictionary,
  withCaptureDisabled,
} from './snapshot';
import { reconcile } from './reconcile';
import { reconcileStockQuantity, replayStockQuantity } from './delta-crdt';
import type { StockQuantityDelta } from './types';

/**
 * The `stock_deltas` convergence ledger (issue #188), phase S0.
 *
 * S0 records — it does not yet reconcile. Its contract is a single invariant: after *any* local
 * movement, every live `(item, location, batch)` placement's `stock_batches.quantity` equals the
 * sum of the `stock_deltas` captured for that key. The capture triggers compute `NEW - OLD`, the
 * actually-applied (CHECK-clamped) change, so the invariant holds by construction for every write
 * path — the repository movement here is just a representative sample. The second half proves the
 * capture switch: a sync/backup apply, which re-inserts `stock_batches` rows whose deltas already
 * travel in the unioned ledger, must record NO new deltas (double-counting would corrupt the sum).
 */
describe('stock_deltas — capture invariant (issue #188, S0)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /**
   * Assert `stock_batches.quantity == Σ(stock_deltas)` for every live placement of `itemId`, and
   * that no delta names a placement with no surviving row (true on a single device that deletes no
   * location — deleted keys leave inert deltas, which are out of the live-key invariant's scope).
   */
  async function assertInvariant(itemId: string): Promise<void> {
    const rows = await driver.query<{ id: string; q: number; s: number }>(
      `SELECT sb.id AS id, sb.quantity AS q,
              COALESCE((SELECT SUM(d.quantity_delta) FROM stock_deltas d
                        WHERE d.item_id = sb.item_id AND d.location_id = sb.location_id
                          AND d.batch_key = sb.batch_key), 0) AS s
       FROM stock_batches sb WHERE sb.item_id = ?;`,
      [itemId],
    );
    for (const row of rows) {
      expect(Number(row.s), `Σ deltas must equal quantity for ${row.id}`).toBe(Number(row.q));
    }
    const orphaned = await driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_deltas d
       WHERE d.item_id = ? AND NOT EXISTS (
         SELECT 1 FROM stock_batches sb
         WHERE sb.item_id = d.item_id AND sb.location_id = d.location_id AND sb.batch_key = d.batch_key);`,
      [itemId],
    );
    expect(Number(orphaned?.n), 'no delta should name a placement with no live row').toBe(0);
  }

  it('holds the invariant across a representative sequence of movements', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const b = await locations.create({ name: 'Drawer B' });

    // Create seed (absolute set) → +60 delta on the home placement.
    const item = await items.create({ name: 'Resistor', quantity: 60, locationId: a.id });
    await assertInvariant(item.id);

    // Signed adjustments: an increment grows the untracked batch, a decrement draws it down.
    await items.adjustQuantity(item.id, 10);
    await assertInvariant(item.id);
    await items.adjustQuantity(item.id, -25);
    await assertInvariant(item.id);

    // Transfer between placements: −q at the source, +q at the destination (net item unchanged).
    await items.transferStock(item.id, a.id, b.id, 20);
    await assertInvariant(item.id);

    // Permanent outbound draws (FEFO consumption).
    await items.sell({ itemId: item.id, quantity: 4, fromLocationId: a.id });
    await assertInvariant(item.id);
    await items.writeOff({ itemId: item.id, quantity: 2, fromLocationId: b.id });
    await assertInvariant(item.id);

    // The grand total is the sum of every placement's Σ deltas — the whole point of the ledger.
    const reread = await items.getById(item.id);
    const totalDelta = await driver.queryOne<{ s: number }>(
      'SELECT COALESCE(SUM(quantity_delta), 0) AS s FROM stock_deltas WHERE item_id = ?;',
      [item.id],
    );
    expect(Number(totalDelta?.s)).toBe(reread!.quantity);
    expect(reread!.quantity).toBe(60 + 10 - 25 - 4 - 2);
  });

  it('records a signed delta for every quantity change, and none for a no-op', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Cap', quantity: 5, locationId: a.id });

    const count = async () =>
      Number(
        (
          await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM stock_deltas WHERE item_id = ?;', [
            item.id,
          ])
        )?.n,
      );

    const afterSeed = await count();
    expect(afterSeed).toBe(1); // the +5 seed

    await items.adjustQuantity(item.id, 3);
    expect(await count()).toBe(2);

    // A zero-delta adjustment is rejected as a no-op by the repository, so no delta is recorded.
    await expect(items.adjustQuantity(item.id, 0)).resolves.toBeDefined();
    expect(await count()).toBe(2);
  });

  it('suppresses capture during a sync/backup apply so deltas are not double-counted', async () => {
    // Device A: build up some stock, then snapshot it (the snapshot carries the deltas).
    const a = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Bolt', quantity: 40, locationId: a.id });
    await items.adjustQuantity(item.id, -15);
    const snapshot = await buildLocalSnapshot(driver);
    expect(snapshot.stockDeltas.length).toBeGreaterThan(0);

    // Device B: a fresh database receives A's snapshot via the destructive clone path. The clone
    // re-inserts A's `stock_batches` rows — which, without the capture guard, would fire the
    // capture triggers and record a SECOND set of deltas for the same physical stock.
    const deviceB = createMemoryDriver();
    try {
      await runMigrations(deviceB, migrations);
      const dictionary = await buildSchemaDictionary(deviceB, [
        ...SYNC_TABLES,
        ITEM_HISTORY_TABLE,
        STOCK_DELTAS_TABLE,
      ]);
      await deviceB.transaction(withCaptureDisabled(buildCloneStatements(snapshot, dictionary)));

      // B's ledger is exactly A's (union-by-id), not doubled by the clone's own writes.
      const bDeltas = await deviceB.query<{ id: string }>('SELECT id FROM stock_deltas ORDER BY id;');
      expect(bDeltas.map((r) => r.id).sort()).toEqual(
        [...snapshot.stockDeltas].map((r) => String(r.id)).sort(),
      );

      // And the physical quantity matches, with the invariant intact on B.
      const q = await deviceB.queryOne<{ quantity: number }>('SELECT quantity FROM items WHERE id = ?;', [
        item.id,
      ]);
      expect(Number(q?.quantity)).toBe(25);
      const check = await deviceB.query<{ q: number; s: number }>(
        `SELECT sb.quantity AS q,
                COALESCE((SELECT SUM(d.quantity_delta) FROM stock_deltas d
                          WHERE d.item_id = sb.item_id AND d.location_id = sb.location_id
                            AND d.batch_key = sb.batch_key), 0) AS s
         FROM stock_batches sb WHERE sb.item_id = ?;`,
        [item.id],
      );
      for (const row of check) expect(Number(row.s)).toBe(Number(row.q));
    } finally {
      await deviceB.close();
    }
  });
});

describe('reconcileStockQuantity — pure replay (issue #188, S1)', () => {
  /** An ordinary relative movement. `createdAt` orders the replay; `id` breaks a tie. */
  const d = (id: string, quantityDelta: number, createdAt = 0): StockQuantityDelta => ({
    id,
    quantityDelta,
    createdAt,
    assertedQuantity: null,
  });
  /**
   * A cycle count's delta (issue #633): the same true `quantityDelta` the trigger records, plus
   * the quantity physically observed, which is what the replay restarts from.
   */
  const counted = (id: string, quantityDelta: number, observed: number, createdAt: number) => ({
    ...d(id, quantityDelta, createdAt),
    assertedQuantity: observed,
  });

  it('sums the id-union of both sides over a base of zero', () => {
    // Shared seed (+10), then each device drew the placement down independently.
    const local = [d('seed', 10), d('a', -3)];
    const remote = [d('seed', 10), d('b', -4)];
    expect(reconcileStockQuantity(local, remote)).toBe(3); // 10 − 3 − 4, NOT 6 or 7
  });

  it('de-duplicates a delta seen on both sides (counts it once)', () => {
    const local = [d('seed', 10), d('a', -3)];
    // The remote already saw a's decrement (it synced); it must not be double-subtracted.
    const remote = [d('seed', 10), d('a', -3)];
    expect(reconcileStockQuantity(local, remote)).toBe(7);
  });

  it('is commutative — both devices reach the same quantity', () => {
    const local = [d('seed', 10), d('a', -3), d('c', 2)];
    const remote = [d('seed', 10), d('b', -4)];
    expect(reconcileStockQuantity(local, remote)).toBe(reconcileStockQuantity(remote, local));
  });

  it('floors concurrent over-consumption at zero rather than going negative', () => {
    // Both devices sold 8 of a shared 10 — 16 drawn from 10. The honest remainder is negative.
    const local = [d('seed', 10), d('a', -8)];
    const remote = [d('seed', 10), d('b', -8)];
    expect(reconcileStockQuantity(local, remote)).toBe(0);
  });

  // --- Absolute counts (issue #633) --------------------------------------------------------
  //
  // A cycle count states what is on the shelf, so counting the same shelf twice must be the
  // no-op it is in the real world — not two corrections applied one after the other.

  it('takes the counted figure as the base rather than adding its correction (issue #633)', () => {
    // The drawer holds 10 per the shared seed; physically there are 8. Both devices count 8,
    // each recording its own −2 with its own random id. Summing them lands on 6.
    const local = [d('seed', 10), counted('a', -2, 8, 100)];
    const remote = [d('seed', 10), counted('b', -2, 8, 200)];
    expect(reconcileStockQuantity(local, remote)).toBe(8);
  });

  it('applies movements recorded after the newest count on top of it', () => {
    // Counted 8, then three units genuinely left the drawer — the count is a base, not a full stop.
    const local = [d('seed', 10), counted('a', -2, 8, 100), d('c', -3, 300)];
    const remote = [d('seed', 10), counted('b', -2, 8, 200)];
    expect(reconcileStockQuantity(local, remote)).toBe(5);
  });

  it('lets the newest count win when two devices count the same shelf differently', () => {
    // One counter found 8, the other 9 — a real disagreement, resolved by the later observation
    // rather than by adding both corrections (which would give 7, a figure neither of them saw).
    const local = [d('seed', 10), counted('a', -2, 8, 100)];
    const remote = [d('seed', 10), counted('b', -1, 9, 200)];
    expect(reconcileStockQuantity(local, remote)).toBe(9);
    expect(reconcileStockQuantity(remote, local)).toBe(9);
  });

  it('orders two counts stamped the same instant by id, so both devices agree', () => {
    const local = [d('seed', 10), counted('aaa', -2, 8, 100)];
    const remote = [d('seed', 10), counted('bbb', -3, 7, 100)];
    // 'bbb' sorts last, so its observation is the newest — and it is on both devices.
    expect(reconcileStockQuantity(local, remote)).toBe(7);
    expect(reconcileStockQuantity(remote, local)).toBe(7);
  });

  it('still applies a movement stamped the same instant as a count', () => {
    // Nothing says which of the two happened first, and discarding a real movement is the worse
    // reading of that — so the count is taken as the earlier event and the −3 lands on top of it.
    const local = [d('seed', 10), counted('a', -2, 8, 100)];
    const remote = [d('seed', 10), d('b', -3, 100)];
    expect(reconcileStockQuantity(local, remote)).toBe(5);
    expect(reconcileStockQuantity(remote, local)).toBe(5);
  });

  it('still floors a count that later movements draw past zero', () => {
    const local = [counted('a', 3, 3, 100), d('b', -5, 200)];
    expect(reconcileStockQuantity(local, [])).toBe(0);
  });
});

describe('replayStockQuantity — one side, unclamped (issue #633)', () => {
  const row = (
    id: string,
    quantityDelta: number,
    createdAt: number,
    assertedQuantity: number | null = null,
  ): StockQuantityDelta => ({ id, quantityDelta, createdAt, assertedQuantity });

  it('reconstructs a single device’s quantity, whose ledger is a linear history', () => {
    // +10, counted 8 (−2), −3 → the row reads 5, and so does the replay.
    expect(replayStockQuantity([row('a', 10, 100), row('b', -2, 200, 8), row('c', -3, 300)])).toBe(5);
  });

  it('reports the honest negative rather than flooring, so an incomplete ledger stays visible', () => {
    // The completeness guard compares this against the stored quantity; flooring here would let a
    // ledger that sums to −5 pass beside a row reading 0.
    expect(replayStockQuantity([row('a', -5, 100)])).toBe(-5);
  });

  it('re-establishes a baseline a wiped ledger lost', () => {
    // A history-excluded restore leaves stock with no deltas to explain it. A physical count says
    // what is there outright, so the replay reconstructs the row from that point on.
    expect(replayStockQuantity([row('a', -2, 200, 8), row('b', -1, 300)])).toBe(7);
  });
});

describe('discrete-stock convergence — the #188 scenario end-to-end (S1)', () => {
  it('converges two concurrent decrements to the true remainder, losing neither', async () => {
    const dictOf = (driver: MemoryDriver) =>
      buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE]);

    // Device A creates the item, then clones its exact state (including the +10 seed delta, with
    // its id preserved) to a fresh device B — the "same starting point" the two then diverge from.
    const a = createMemoryDriver();
    const b = createMemoryDriver();
    try {
      await runMigrations(a, migrations);
      const itemsA = new ItemRepository(a);
      const loc = await new LocationRepository(a).create({ name: 'Workshop' });
      const item = await itemsA.create({ name: 'Bracket', quantity: 10, locationId: loc.id });

      await runMigrations(b, migrations);
      const start = await buildLocalSnapshot(a);
      await b.transaction(withCaptureDisabled(buildCloneStatements(start, await dictOf(b))));
      const itemsB = new ItemRepository(b);

      // Concurrent, offline: A checks out 3 units (10 → 7), B checks out 4 (10 → 6). Under plain
      // LWW they would converge to 6 or 7 — never 3 — silently discarding one decrement.
      await itemsA.adjustQuantity(item.id, -3);
      await itemsB.adjustQuantity(item.id, -4);

      const snapA = await buildLocalSnapshot(a);
      const snapB = await buildLocalSnapshot(b);

      // Each device merges the other's snapshot from its own side (as the real sync does).
      const dictA = await dictOf(a);
      const dictB = await dictOf(b);
      await applyPlan(a, reconcile(snapA, snapB, { offset: 0, dictionary: dictA }), dictA);
      await applyPlan(b, reconcile(snapB, snapA, { offset: 0, dictionary: dictB }), dictB);

      // Both devices converge to the true remainder, 3, and the derived total agrees.
      expect((await itemsA.getById(item.id))!.quantity).toBe(3);
      expect((await itemsB.getById(item.id))!.quantity).toBe(3);

      // Neither movement was lost: both decrements survive in the ledger on both devices, and the
      // capture invariant still holds (quantity == Σ deltas) because no floor was hit.
      for (const driver of [a, b]) {
        const decrements = await driver.queryOne<{ n: number }>(
          'SELECT COUNT(*) AS n FROM stock_deltas WHERE item_id = ? AND quantity_delta < 0;',
          [item.id],
        );
        expect(Number(decrements?.n), 'both concurrent decrements are recorded').toBe(2);
        const row = await driver.queryOne<{ q: number; s: number }>(
          `SELECT sb.quantity AS q,
                  (SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_deltas
                   WHERE item_id = sb.item_id AND location_id = sb.location_id AND batch_key = sb.batch_key) AS s
           FROM stock_batches sb WHERE sb.item_id = ?;`,
          [item.id],
        );
        expect(Number(row?.q)).toBe(3);
        expect(Number(row?.s)).toBe(3);
      }

      // Idempotence / no churn: now that both sides hold the same deltas, a further reconcile must
      // produce NO stock resolution — otherwise a redundant `UPDATE … SET quantity = 3` would bump
      // updated_at and re-push the row on every sync forever (the re-sync ping-pong bug).
      const plan = reconcile(await buildLocalSnapshot(a), await buildLocalSnapshot(b), {
        offset: 0,
        dictionary: dictA,
      });
      expect(plan.stockResolutions).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('falls back to LWW for a baseline-less placement rather than converging to a wrong value', async () => {
    const dictOf = (driver: MemoryDriver) =>
      buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE]);

    const a = createMemoryDriver();
    const b = createMemoryDriver();
    try {
      await runMigrations(a, migrations);
      const itemsA = new ItemRepository(a);
      const loc = await new LocationRepository(a).create({ name: 'Bin' });
      const item = await itemsA.create({ name: 'Washer', quantity: 40, locationId: loc.id });
      await runMigrations(b, migrations);
      await b.transaction(
        withCaptureDisabled(buildCloneStatements(await buildLocalSnapshot(a), await dictOf(b))),
      );
      const itemsB = new ItemRepository(b);

      // Simulate a history-excluded restore on A: its stock persists but its ledger is wiped, so
      // A's placement is now "baseline-less" (quantity 40, Σ deltas 0). Both devices then move.
      await a.execute('DELETE FROM stock_deltas;');
      await itemsA.adjustQuantity(item.id, -3); // A ledger: {-3}, quantity 37 (base 40 not in ledger)
      await itemsB.adjustQuantity(item.id, -2); // B ledger: {seed +40, -2}, quantity 38 (complete)

      // The naive CRDT would union {-3, -2} = -5 → clamp 0 and wipe the stock. The completeness
      // guard sees A's ledger is incomplete (Σ ≠ quantity) and emits NO resolution, so LWW stands.
      const plan = reconcile(await buildLocalSnapshot(a), await buildLocalSnapshot(b), {
        offset: 0,
        dictionary: await dictOf(a),
      });
      expect(plan.stockResolutions).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('absolute cycle counts — the #633 scenario end-to-end', () => {
  const dictOf = (driver: MemoryDriver) =>
    buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE]);

  /** Two devices that started from the same state: a drawer holding `quantity` of one item. */
  async function twoDevicesHolding(quantity: number) {
    const a = createMemoryDriver();
    const b = createMemoryDriver();
    await runMigrations(a, migrations);
    const itemsA = new ItemRepository(a);
    const drawer = await new LocationRepository(a).create({ name: 'Drawer A2' });
    const item = await itemsA.create({ name: 'Bracket', quantity, locationId: drawer.id });
    await runMigrations(b, migrations);
    await b.transaction(
      withCaptureDisabled(buildCloneStatements(await buildLocalSnapshot(a), await dictOf(b))),
    );
    return { a, b, itemsA, itemsB: new ItemRepository(b), item, drawer };
  }

  /** The adjustment the count sheet builds for a drifted untracked lot at a placement. */
  const countOf = (item: { id: string }, drawer: { id: string; name: string }, physical: number) => [
    {
      itemId: item.id,
      counted: physical,
      locationName: drawer.name,
      locationId: drawer.id,
      batch: UNTRACKED_BATCH,
    },
  ];

  /**
   * Wait long enough that the next ledger row is stamped strictly later than the last. Two writes
   * inside one millisecond are a genuine tie the replay resolves by rule (see the pure tests);
   * these cases are about what happens when the order *is* known.
   *
   * Two whole milliseconds, not one: `created_at` is `ROUND(unixepoch('now','subsec') * 1000)`
   * while `Date.now()` truncates, so waiting for `Date.now()` merely to change can leave under a
   * microsecond of real time before the next write, and rounding can then land both writes on the
   * same stamp. Waiting for it to advance by two guarantees more than a millisecond of real time
   * has passed, and `ROUND` is monotonic, so the stamps must differ.
   */
  async function clockTick(): Promise<void> {
    const from = Date.now();
    while (Date.now() < from + 2) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  /** Merge each device's view of the other, exactly as the real sync does from both ends. */
  async function syncBothWays(a: MemoryDriver, b: MemoryDriver) {
    const snapA = await buildLocalSnapshot(a);
    const snapB = await buildLocalSnapshot(b);
    const dictA = await dictOf(a);
    const dictB = await dictOf(b);
    await applyPlan(a, reconcile(snapA, snapB, { offset: 0, dictionary: dictA }), dictA);
    await applyPlan(b, reconcile(snapB, snapA, { offset: 0, dictionary: dictB }), dictB);
  }

  it('converges on the counted figure when the same drawer is counted on two devices', async () => {
    // An audit day with a phone each: the database says 10, both counters find 8, neither device
    // syncs in between. Each records its own −2 with its own id, so summing the union gives 6 —
    // a figure neither counter ever saw, agreed on by both devices and stamped as freshly counted.
    const { a, b, itemsA, itemsB, item, drawer } = await twoDevicesHolding(10);
    try {
      await itemsA.reconcile(countOf(item, drawer, 8));
      await itemsB.reconcile(countOf(item, drawer, 8));
      expect((await itemsA.getById(item.id))!.quantity).toBe(8);
      expect((await itemsB.getById(item.id))!.quantity).toBe(8);

      await syncBothWays(a, b);

      expect((await itemsA.getById(item.id))!.quantity).toBe(8);
      expect((await itemsB.getById(item.id))!.quantity).toBe(8);

      // Both counts survive in the ledger as observations — nothing was discarded to get there.
      for (const driver of [a, b]) {
        const observations = await driver.queryOne<{ n: number }>(
          'SELECT COUNT(*) AS n FROM stock_deltas WHERE item_id = ? AND asserted_quantity IS NOT NULL;',
          [item.id],
        );
        expect(Number(observations?.n)).toBe(2);
      }

      // And it settles: with both sides holding the same deltas there is nothing left to resolve,
      // so no redundant `UPDATE … SET quantity = 8` re-pushes the row every sync.
      const plan = reconcile(await buildLocalSnapshot(a), await buildLocalSnapshot(b), {
        offset: 0,
        dictionary: await dictOf(a),
      });
      expect(plan.stockResolutions).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('keeps a movement made after the count, on either device', async () => {
    // The count is a new baseline, not a full stop: A counts 8, then B (which never counted)
    // genuinely takes 3 out. The drawer must settle at 5, not back at the counted 8.
    const { a, b, itemsA, itemsB, item, drawer } = await twoDevicesHolding(10);
    try {
      await itemsA.reconcile(countOf(item, drawer, 8));
      await clockTick();
      await itemsB.adjustQuantity(item.id, -3);

      await syncBothWays(a, b);

      expect((await itemsA.getById(item.id))!.quantity).toBe(5);
      expect((await itemsB.getById(item.id))!.quantity).toBe(5);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('supersedes a movement the count had already seen on the shelf', async () => {
    // B takes 3 out (10 → 7) while A is offline; A then walks the drawer and counts 8. A's sheet
    // still says 10, so it records −2 — but what A physically saw already reflects whatever had
    // left the drawer by then. The later observation is the better evidence, so both devices land
    // on 8 rather than on 10 − 3 − 2.
    const { a, b, itemsA, itemsB, item, drawer } = await twoDevicesHolding(10);
    try {
      await itemsB.adjustQuantity(item.id, -3);
      await clockTick();
      await itemsA.reconcile(countOf(item, drawer, 8));

      await syncBothWays(a, b);

      expect((await itemsA.getById(item.id))!.quantity).toBe(8);
      expect((await itemsB.getById(item.id))!.quantity).toBe(8);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('leaves an ordinary movement relative — two decrements still both count', async () => {
    // The regression guard for #188: only a count asserts. Two genuine draws must still sum, so
    // the assertion path cannot have quietly turned every write into a last-one-wins overwrite.
    const { a, b, itemsA, itemsB, item } = await twoDevicesHolding(10);
    try {
      await itemsA.adjustQuantity(item.id, -3);
      await itemsB.adjustQuantity(item.id, -4);
      await syncBothWays(a, b);
      expect((await itemsA.getById(item.id))!.quantity).toBe(3);
      expect((await itemsB.getById(item.id))!.quantity).toBe(3);

      const asserted = await a.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM stock_deltas WHERE asserted_quantity IS NOT NULL;',
      );
      expect(Number(asserted?.n), 'no ordinary movement is recorded as an observation').toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('records the counted quantity, not the correction, and only for the count’s own writes', async () => {
    // The switch must close behind the count: the adjustment that follows it is a movement again.
    const { a, b, itemsA, item, drawer } = await twoDevicesHolding(10);
    try {
      await itemsA.reconcile(countOf(item, drawer, 8));
      await clockTick(); // so `ORDER BY created_at` below is the order they were written in
      await itemsA.adjustQuantity(item.id, -1);
      const rows = await a.query<{ quantity_delta: number; asserted_quantity: number | null }>(
        'SELECT quantity_delta, asserted_quantity FROM stock_deltas WHERE item_id = ? ORDER BY created_at, id;',
        [item.id],
      );
      expect(rows.map((r) => [Number(r.quantity_delta), r.asserted_quantity ?? null])).toEqual([
        [10, null], // the create seed
        [-2, 8], // the count: the true applied change, plus what was physically there
        [-1, null], // an ordinary draw afterwards
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('does not assert a whole-placement count, whose per-lot figures nobody observed', async () => {
    // A count that names no lot states a total, which `placementDeltaStatements` spreads across
    // lots FEFO. Those per-lot figures are an allocation, not an observation, and asserting them
    // would let two devices' different allocations converge on a total neither counter reported.
    const { a, b, itemsA, item, drawer } = await twoDevicesHolding(10);
    try {
      await itemsA.reconcile([
        { itemId: item.id, counted: 8, locationName: drawer.name, locationId: drawer.id },
      ]);
      expect((await itemsA.getById(item.id))!.quantity).toBe(8);
      const asserted = await a.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM stock_deltas WHERE item_id = ? AND asserted_quantity IS NOT NULL;',
        [item.id],
      );
      expect(Number(asserted?.n)).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  /** One placement's ledger, projected as the replay consumes it. */
  async function ledgerOf(driver: MemoryDriver, itemId: string): Promise<StockQuantityDelta[]> {
    const rows = await driver.query<{
      id: string;
      quantity_delta: number;
      created_at: number;
      asserted_quantity: number | null;
    }>('SELECT id, quantity_delta, created_at, asserted_quantity FROM stock_deltas WHERE item_id = ?;', [
      itemId,
    ]);
    return rows.map((r) => ({
      id: String(r.id),
      quantityDelta: Number(r.quantity_delta),
      createdAt: Number(r.created_at),
      assertedQuantity: r.asserted_quantity == null ? null : Number(r.asserted_quantity),
    }));
  }

  it('stamps a count past the newest row at its placement, however that row was stamped', async () => {
    // The deterministic half of the two same-instant cases below: a row is planted a minute in the
    // future — the shape a peer with a fast clock syncs in — and the count that follows must still
    // sort after it. Without the nudge the count takes the plain clock, lands before a row it is
    // meant to supersede, and the placement's ledger stops reconstructing its own row.
    const { a, b, itemsA, item, drawer } = await twoDevicesHolding(10);
    try {
      const ahead = Date.now() + 60_000;
      await a.execute(
        `INSERT INTO stock_deltas (id, item_id, location_id, batch_key, quantity_delta, created_at)
         VALUES ('planted', ?, ?, '', 0, ?);`,
        [item.id, drawer.id, ahead],
      );
      await itemsA.reconcile(countOf(item, drawer, 8));

      const assertion = await a.queryOne<{ created_at: number }>(
        'SELECT created_at FROM stock_deltas WHERE item_id = ? AND asserted_quantity IS NOT NULL;',
        [item.id],
      );
      expect(Number(assertion?.created_at)).toBeGreaterThan(ahead);
    } finally {
      await a.close();
      await b.close();
    }
  });

  // A device's own ledger must always replay back to its own stored quantity — that is the
  // completeness guard `reconcileStock` uses to decide a side is trustworthy. A count and a
  // movement committing in the same millisecond would tie, and the tie rule (count first) would
  // then reconstruct the wrong figure for one of the two orderings — which fails the guard for
  // that placement on *every* future sync, quietly dropping it out of the convergence engine.
  // Both orderings are run without a clock tick, so they land in the same instant.
  for (const [name, order] of [
    ['a movement then a count', ['move', 'count']],
    ['a count then a movement', ['count', 'move']],
  ] as const) {
    it(`reconstructs the row when ${name} land in the same instant`, async () => {
      const { a, b, itemsA, item, drawer } = await twoDevicesHolding(10);
      try {
        await clockTick(); // separate the create seed, so only the pair below can tie
        for (const step of order) {
          if (step === 'move') await itemsA.adjustQuantity(item.id, -1);
          else await itemsA.reconcile(countOf(item, drawer, 8));
        }
        const stored = await a.queryOne<{ quantity: number }>(
          'SELECT quantity FROM stock_batches WHERE item_id = ?;',
          [item.id],
        );
        expect(replayStockQuantity(await ledgerOf(a, item.id))).toBe(Number(stored?.quantity));
      } finally {
        await a.close();
        await b.close();
      }
    });
  }
});
