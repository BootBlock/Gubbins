/**
 * Where a SERIALISED instance's one unit sits, and the paths that move it (issue #640).
 *
 * `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)` says a serialised record is one physical
 * thing. `items.quantity` is a trigger-derived `SUM(item_stock)`, and every relocation is
 * necessarily two writes — empty one placement, fill another — so a per-statement recompute walks
 * that total through 2 or 0 and the CHECK aborts the whole transaction. That made *every*
 * wholesale move of a serialised unit impossible: `move()`, an assembly draw, and deleting the
 * location it sat in. `withRecomputeDeferred` is what makes them legal, by writing the total once
 * at the value it ends on.
 *
 * Nothing enforced *where* the unit sits, though, which mattered the moment a relocation became
 * possible: two devices can each find the same unit on a different shelf, and sync unions the
 * placement rows. The repair in the settle pass is what stops that summing to two and aborting
 * every merge from then on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { withCaptureDisabled } from '@/features/sync/snapshot';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { withRecomputeDeferred } from './stock';

describe('a serialised instance holds one unit, in one place', () => {
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

  /** Every placement of `itemId` holding stock, as `locationId → quantity`. */
  async function placements(itemId: string): Promise<Record<string, number>> {
    const rows = await driver.query<{ location_id: string; quantity: number }>(
      'SELECT location_id, quantity FROM stock_batches WHERE item_id = ? AND quantity <> 0;',
      [itemId],
    );
    return Object.fromEntries(rows.map((r) => [r.location_id, Number(r.quantity)]));
  }

  it('can be deleted out from under, re-homing to Unassigned rather than aborting', async () => {
    // The re-home fills Unassigned before the deleted location's rows are dropped, so the total
    // is briefly two — and a location holding any serialised unit could not be deleted at all.
    const shelf = await locations.create({ name: 'Shelf' });
    const [meter] = await items.createSerialised({ name: 'Meter', count: 1, locationId: shelf.id });

    await locations.delete(shelf.id);

    const moved = await items.getById(meter.id);
    expect(moved?.quantity).toBe(1);
    expect(await placements(meter.id)).toEqual({ [moved!.locationId]: 1 });
    expect(await locations.getById(shelf.id)).toBeUndefined();
  });

  it('converges on one placement when two devices found it in different rooms', async () => {
    // This device counted the garage and relocated the unit there. A peer counted the bench and
    // relocated it there; its placement row arrives in the merge, which applies under the same
    // deferred-recompute bracket. Without the repair the two placements sum to two and the whole
    // merge transaction aborts — every time, until the database is edited by hand.
    const bench = await locations.create({ name: 'Bench' });
    const garage = await locations.create({ name: 'Garage' });
    const store = await locations.create({ name: 'Store' });
    const [meter] = await items.createSerialised({ name: 'Meter', count: 1, locationId: store.id });

    await items.authoriseCount({
      locationId: garage.id,
      quantityAdjustments: [],
      serialisedAdjustments: [],
      relocations: [{ itemId: meter.id, note: 'found here' }],
    });
    expect(await placements(meter.id)).toEqual({ [garage.id]: 1 });

    // The peer's rows, applied exactly as `applyMergePlan` applies them: its `items` row won
    // last-write-wins and names the bench, and its placement row comes with it.
    await driver.transaction(
      withCaptureDisabled(
        withRecomputeDeferred([
          { sql: 'UPDATE items SET location_id = ? WHERE id = ?;', params: [bench.id, meter.id] },
          {
            sql: `INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity)
                  VALUES (?, ?, ?, '', 1) ON CONFLICT(id) DO UPDATE SET quantity = 1;`,
            params: [`${meter.id}|${bench.id}|`, meter.id, bench.id],
          },
        ]),
      ),
    );

    // The bench wins, because the `items` row that names it is what the two devices already agree
    // on — and it holds exactly one unit, with nothing left behind in the garage.
    expect(await placements(meter.id)).toEqual({ [bench.id]: 1 });
    expect((await items.getById(meter.id))?.quantity).toBe(1);
  });

  it('repairs a home placement that has no row of its own', async () => {
    // The other half of the divergence above, reached on its own: the peer's `items` row names a
    // location this device has no placement row for at all. Emptying what it does have would take
    // the unit to zero, which the CHECK forbids just as firmly as two.
    const store = await locations.create({ name: 'Store' });
    const attic = await locations.create({ name: 'Attic' });
    const [meter] = await items.createSerialised({ name: 'Meter', count: 1, locationId: store.id });

    await driver.transaction(
      withCaptureDisabled(
        withRecomputeDeferred([
          { sql: 'UPDATE items SET location_id = ? WHERE id = ?;', params: [attic.id, meter.id] },
        ]),
      ),
    );

    expect(await placements(meter.id)).toEqual({ [attic.id]: 1 });
    expect((await items.getById(meter.id))?.quantity).toBe(1);
  });

  it('leaves a serialised item the placement ledger says nothing about alone', async () => {
    // The `EXISTS` guard the rest of the settle carries, for the same reason: a snapshot holding
    // `items` but no `stock_batches` is not claiming its serialised units are homeless, and this
    // pass reconciles a ledger rather than inventing one.
    //
    // The batch rows go inside the bracket because that is the only place they *can* go: with the
    // recompute triggers live, emptying a serialised item's last placement drives `items.quantity`
    // to zero and the CHECK stops it. Which is also the shape of the case being tested — a restore
    // applying a foreign snapshot, where the whole apply runs deferred.
    const store = await locations.create({ name: 'Store' });
    const [meter] = await items.createSerialised({ name: 'Meter', count: 1, locationId: store.id });

    await driver.transaction(
      withCaptureDisabled(
        withRecomputeDeferred([{ sql: 'DELETE FROM stock_batches WHERE item_id = ?;', params: [meter.id] }]),
      ),
    );

    expect(await placements(meter.id)).toEqual({});
    // Untouched, not repaired to zero: the settle's own `EXISTS` guards leave a placement the
    // batch ledger no longer speaks for exactly as the snapshot delivered it.
    expect((await items.getById(meter.id))?.quantity).toBe(1);
  });

  it('does not disturb a DISCRETE item split across several placements', async () => {
    // The repair is keyed on `tracking_mode = 'SERIALISED'`, and a bulk item legitimately sits in
    // as many drawers as it likes — including drawers its own `location_id` does not name.
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const widget = await items.create({ name: 'Widget', quantity: 10, locationId: a.id });
    await items.transferStock(widget.id, a.id, b.id, 4);

    await driver.transaction(
      withCaptureDisabled(
        withRecomputeDeferred([
          { sql: 'UPDATE items SET name = ? WHERE id = ?;', params: ['Widget 2', widget.id] },
        ]),
      ),
    );

    expect(await placements(widget.id)).toEqual({ [a.id]: 6, [b.id]: 4 });
    expect((await items.getById(widget.id))?.quantity).toBe(10);
  });
});
