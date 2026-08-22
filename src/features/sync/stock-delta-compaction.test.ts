import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { replayStockQuantity, reconcileStockQuantity } from './delta-crdt';
import {
  COMPACTION_GRID_MS,
  STOCK_DELTA_RETENTION_MS,
  TOMBSTONE_TTL_MS,
  stockDeltaCompactionCutoff,
} from './retention';
import { checkpointId, summariseEra, sweepStockDeltas, type PlacementKey } from './stock-delta-compaction';
import type { StockQuantityDelta } from './types';

/**
 * Bounding the `stock_deltas` convergence ledger (issue #544).
 *
 * The contract has two halves. **Replay-equivalence** is the correctness one: replacing a
 * placement's expired era with its checkpoint must leave `replayStockQuantity` returning exactly
 * what it returned before, for the device that swept and for a peer that unions the result in —
 * otherwise the sweep would silently move stock. **Convergence** is the distributed one: two
 * devices sweeping the same placement at the same cutoff must produce the same row, or the ledger
 * would grow by a checkpoint per device instead of shrinking.
 */

/** An ordinary relative movement. */
const move = (id: string, quantityDelta: number, createdAt: number): StockQuantityDelta => ({
  id,
  quantityDelta,
  createdAt,
  assertedQuantity: null,
});

/** A cycle count's row: the physically observed figure, plus the correction it implied. */
const count = (
  id: string,
  quantityDelta: number,
  assertedQuantity: number,
  createdAt: number,
): StockQuantityDelta => ({ id, quantityDelta, createdAt, assertedQuantity });

/** The checkpoint {@link summariseEra} describes, as the replay would read it back. */
function checkpointOf(era: readonly StockQuantityDelta[], cutoff: number): StockQuantityDelta {
  const summary = summariseEra(era);
  return {
    id: 'checkpoint',
    quantityDelta: summary.netDelta,
    createdAt: cutoff - 1,
    assertedQuantity: summary.assertedQuantity,
  };
}

describe('stock-delta retention horizons (issue #544)', () => {
  it('never lets the stock horizon fall short of the tombstone TTL', () => {
    // The whole safety argument for discarding a summarised era: the only peer that can still hold
    // an unsynced movement inside one is a peer past the tombstone TTL, which clones rather than
    // delta-merges. A shorter horizon would open a window the §7.2 clone does not cover.
    expect(STOCK_DELTA_RETENTION_MS).toBeGreaterThanOrEqual(TOMBSTONE_TTL_MS);
  });

  it('snaps the cutoff to a whole day so two devices agree on it', () => {
    const now = 1_800_000_000_000;
    const cutoff = stockDeltaCompactionCutoff(now);
    expect(cutoff % COMPACTION_GRID_MS).toBe(0);
    expect(cutoff).toBeLessThanOrEqual(now - STOCK_DELTA_RETENTION_MS);
    // Clocks minutes apart still land on one cutoff — which is what makes the two devices'
    // checkpoints collapse to a single row instead of accumulating one each.
    expect(stockDeltaCompactionCutoff(now + 37 * 60_000)).toBe(cutoff);
  });
});

describe('summariseEra — the checkpoint that replaces an era (issue #544)', () => {
  it('asserts what the era replays to, and carries the era net movement', () => {
    const era = [move('a', 10, 100), move('b', -3, 200), move('c', 5, 300)];
    expect(summariseEra(era)).toEqual({ assertedQuantity: 12, netDelta: 12 });
  });

  it('takes a cycle count in the era as its base, not as another movement', () => {
    // The count states 8 were on the shelf; the −2 it implied must not be applied on top of it.
    const era = [move('a', 10, 100), count('b', -2, 8, 200), move('c', 1, 300)];
    expect(summariseEra(era)).toEqual({ assertedQuantity: 9, netDelta: 9 });
  });

  it('separates the asserted figure from the net movement when the two differ', () => {
    // A count that corrected a shortfall: the ledger moved −6 in total, but the shelf held 4.
    const era = [move('a', 10, 100), count('b', -6, 4, 200)];
    expect(summariseEra(era)).toEqual({ assertedQuantity: 4, netDelta: 4 });
    // And where the era's own movements do not reconstruct the count, the two genuinely diverge.
    const drifted = [move('a', 10, 100), count('b', -6, 30, 200)];
    expect(summariseEra(drifted)).toEqual({ assertedQuantity: 30, netDelta: 4 });
  });
});

describe('compaction is replay-equivalent (issue #544)', () => {
  const CUTOFF = 1_000_000;

  /** Every shape an era can take, paired with what survives it. */
  const cases: ReadonlyArray<{
    name: string;
    era: readonly StockQuantityDelta[];
    survivors: readonly StockQuantityDelta[];
  }> = [
    {
      name: 'plain movements either side of the horizon',
      era: [move('a', 40, 10), move('b', -15, 20)],
      survivors: [move('x', 7, CUTOFF), move('y', -2, CUTOFF + 500)],
    },
    {
      name: 'a count inside the era',
      era: [move('a', 40, 10), count('b', -32, 8, 20), move('c', 3, 30)],
      survivors: [move('x', -4, CUTOFF + 1)],
    },
    {
      name: 'a count after the horizon, which supersedes the checkpoint',
      era: [move('a', 40, 10), move('b', -15, 20)],
      survivors: [count('x', -20, 5, CUTOFF + 10), move('y', 2, CUTOFF + 20)],
    },
    {
      name: 'an era whose movements net negative',
      era: [move('a', 5, 10), move('b', -9, 20)],
      survivors: [move('x', 1, CUTOFF)],
    },
    {
      name: 'nothing surviving at all',
      era: [move('a', 12, 10), move('b', -4, 20)],
      survivors: [],
    },
  ];

  for (const { name, era, survivors } of cases) {
    it(`leaves the replay unchanged — ${name}`, () => {
      const before = replayStockQuantity([...era, ...survivors]);
      const after = replayStockQuantity([checkpointOf(era, CUTOFF), ...survivors]);
      expect(after).toBe(before);
    });

    it(`leaves SUM(quantity_delta) unchanged — ${name}`, () => {
      const sum = (rows: readonly StockQuantityDelta[]) => rows.reduce((t, d) => t + d.quantityDelta, 0);
      expect(sum([checkpointOf(era, CUTOFF), ...survivors])).toBe(sum([...era, ...survivors]));
    });

    it(`converges with a peer that has not swept — ${name}`, () => {
      // The peer still holds the raw era. The union must land where both sides' full ledgers do,
      // not somewhere between them: the checkpoint asserts the era, and the peer's own copies of
      // those movements sort before it, so they are superseded rather than double-counted.
      const swept = [checkpointOf(era, CUTOFF), ...survivors];
      const unswept = [...era, ...survivors];
      expect(reconcileStockQuantity(swept, unswept)).toBe(Math.max(0, replayStockQuantity(unswept)));
    });
  }
});

describe('sweepStockDeltas — against the real schema (issue #544)', () => {
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

  /** Backdate every delta of `itemId` by `ms`, standing in for a ledger that has aged. */
  async function age(itemId: string, ms: number): Promise<void> {
    // A plain UPDATE would hit the append-only trigger, so read each row out and write it back
    // whole — the same shape it would have had if the movement had been recorded that long ago.
    const rows = await driver.query<{
      id: string;
      item_id: string;
      location_id: string;
      batch_key: string;
      quantity_delta: number;
      created_at: number;
      asserted_quantity: number | null;
    }>(
      `SELECT id, item_id, location_id, batch_key, quantity_delta, created_at, asserted_quantity
         FROM stock_deltas WHERE item_id = ?;`,
      [itemId],
    );
    await driver.transaction([
      ...rows.map((r) => ({ sql: 'DELETE FROM stock_deltas WHERE id = ?;', params: [r.id] })),
      ...rows.map((r) => ({
        sql: `INSERT INTO stock_deltas (id, item_id, location_id, batch_key, quantity_delta,
                                        created_at, asserted_quantity)
              VALUES (?, ?, ?, ?, ?, ?, ?);`,
        params: [
          r.id,
          r.item_id,
          r.location_id,
          r.batch_key,
          r.quantity_delta,
          Number(r.created_at) - ms,
          r.asserted_quantity,
        ],
      })),
    ]);
  }

  /** Every ledger row of `itemId`, projected for the pure replay. */
  async function ledger(itemId: string): Promise<StockQuantityDelta[]> {
    const rows = await driver.query<{
      id: string;
      quantity_delta: number;
      created_at: number;
      asserted_quantity: number | null;
    }>(
      `SELECT id, quantity_delta, created_at, asserted_quantity
         FROM stock_deltas WHERE item_id = ? ORDER BY created_at, id;`,
      [itemId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      quantityDelta: Number(r.quantity_delta),
      createdAt: Number(r.created_at),
      assertedQuantity: r.asserted_quantity === null ? null : Number(r.asserted_quantity),
    }));
  }

  it('prunes the deltas a deleted location strands, and nothing else', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const shelf = await locations.create({ name: 'Shelf B' });
    const item = await items.create({ name: 'Resistor', quantity: 60, locationId: drawer.id });
    await items.transferStock(item.id, drawer.id, shelf.id, 20);

    const before = await ledger(item.id);
    expect(before.length).toBeGreaterThan(1);

    // Deleting the drawer re-homes its stock to Unassigned and drops its batch rows. The deltas
    // at the drawer survive that delete — `location_id` is a plain column with no cascade — and
    // nothing could ever replay them again.
    await locations.delete(drawer.id);
    const stranded = await driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_deltas d WHERE d.location_id = ?;`,
      [drawer.id],
    );
    expect(Number(stranded?.n)).toBeGreaterThan(0);

    // A cutoff far in the past means only the orphan prune can act here.
    const result = await sweepStockDeltas(driver, 0);
    expect(result.orphansPruned).toBe(Number(stranded?.n));
    expect(result.placementsCompacted).toBe(0);

    // Every surviving delta still names a live placement, and every live placement still
    // reconstructs its own quantity — the invariant `reconcileStock` trusts.
    const dangling = await driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stock_deltas d WHERE NOT EXISTS (
         SELECT 1 FROM stock_batches sb WHERE sb.item_id = d.item_id
           AND sb.location_id = d.location_id AND sb.batch_key = d.batch_key);`,
    );
    expect(Number(dangling?.n)).toBe(0);
    await expectPlacementsReconstruct(item.id);
  });

  it('summarises an expired era into one checkpoint that replays to the same quantity', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Bolt', quantity: 40, locationId: drawer.id });
    await items.adjustQuantity(item.id, -15);
    await items.adjustQuantity(item.id, 5);

    const before = await ledger(item.id);
    expect(before).toHaveLength(3);
    const quantityBefore = replayStockQuantity(before);
    expect(quantityBefore).toBe(30);

    await age(item.id, 2 * STOCK_DELTA_RETENTION_MS);
    const cutoff = stockDeltaCompactionCutoff(Date.now());
    const result = await sweepStockDeltas(driver, cutoff);

    expect(result).toEqual({ orphansPruned: 0, erasCompacted: 3, placementsCompacted: 1 });
    const after = await ledger(item.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.assertedQuantity).toBe(quantityBefore);
    expect(after[0]!.createdAt).toBe(cutoff - 1);
    expect(replayStockQuantity(after)).toBe(quantityBefore);
    await expectPlacementsReconstruct(item.id);
  });

  it('leaves movements newer than the cutoff alone, and stacks them on the checkpoint', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Nut', quantity: 100, locationId: drawer.id });
    await items.adjustQuantity(item.id, -10);
    await age(item.id, 2 * STOCK_DELTA_RETENTION_MS);
    // A recent movement, inside the retention horizon.
    await items.adjustQuantity(item.id, -7);

    const quantityBefore = replayStockQuantity(await ledger(item.id));
    const result = await sweepStockDeltas(driver, stockDeltaCompactionCutoff(Date.now()));

    expect(result.erasCompacted).toBe(2);
    const after = await ledger(item.id);
    expect(after).toHaveLength(2);
    expect(after[0]!.assertedQuantity).toBe(90);
    expect(after[1]!.assertedQuantity).toBeNull();
    expect(after[1]!.quantityDelta).toBe(-7);
    expect(replayStockQuantity(after)).toBe(quantityBefore);
  });

  it('is idempotent — a second sweep rewrites nothing', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Washer', quantity: 8, locationId: drawer.id });
    await items.adjustQuantity(item.id, 4);
    await age(item.id, 2 * STOCK_DELTA_RETENTION_MS);

    const cutoff = stockDeltaCompactionCutoff(Date.now());
    await sweepStockDeltas(driver, cutoff);
    const once = await ledger(item.id);

    // Re-sweeping at the same cutoff must not re-mint the checkpoint: a rewritten row would be
    // pushed as a change every sync and unioned in by every peer as another dead checkpoint.
    const again = await sweepStockDeltas(driver, cutoff);
    expect(again).toEqual({ orphansPruned: 0, erasCompacted: 0, placementsCompacted: 0 });
    expect(await ledger(item.id)).toEqual(once);
  });

  it('gives two devices sweeping the same placement the same checkpoint row', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Screw', quantity: 25, locationId: drawer.id });
    await items.adjustQuantity(item.id, -5);
    await age(item.id, 2 * STOCK_DELTA_RETENTION_MS);
    const cutoff = stockDeltaCompactionCutoff(Date.now());
    await sweepStockDeltas(driver, cutoff);

    const [row] = await ledger(item.id);
    const key: PlacementKey = { itemId: item.id, locationId: drawer.id, batchKey: '' };
    // The id is a pure function of the placement and the cutoff, so the peer's own sweep writes
    // this same row and the id-union keeps one copy rather than two.
    expect(row!.id).toBe(await checkpointId(key, cutoff));
    expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  /** Every live placement of `itemId` must still satisfy the CRDT's completeness invariant. */
  async function expectPlacementsReconstruct(itemId: string): Promise<void> {
    const placements = await driver.query<{ location_id: string; batch_key: string; quantity: number }>(
      'SELECT location_id, batch_key, quantity FROM stock_batches WHERE item_id = ?;',
      [itemId],
    );
    const all = await ledger(itemId);
    const rows = await driver.query<{ id: string; location_id: string; batch_key: string }>(
      'SELECT id, location_id, batch_key FROM stock_deltas WHERE item_id = ?;',
      [itemId],
    );
    const placementOf = new Map(rows.map((r) => [String(r.id), `${r.location_id} ${r.batch_key}`]));
    for (const p of placements) {
      const mine = all.filter((d) => placementOf.get(d.id) === `${p.location_id} ${p.batch_key}`);
      expect(replayStockQuantity(mine), `replay must reconstruct ${p.location_id}/${p.batch_key}`).toBe(
        Number(p.quantity),
      );
    }
  }
});
