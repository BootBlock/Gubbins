import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE, SYNC_TABLES } from '@/db/repositories/tombstone';
import { buildLocalSnapshot, buildCloneStatements, buildSchemaDictionary } from './snapshot';

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
      await deviceB.transaction(buildCloneStatements(snapshot, dictionary));

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
