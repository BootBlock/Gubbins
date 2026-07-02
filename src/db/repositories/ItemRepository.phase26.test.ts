import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { CheckoutRepository } from './CheckoutRepository';

/**
 * Phase 26 — per-location cycle count + checkout source. Both deepen the Phase-25
 * `item_stock` ledger so the §4.4 audit and the §4 loan act on a *specific* placement
 * rather than the item's primary location.
 */
describe('ItemRepository — per-location cycle count (Phase 26)', () => {
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

  it('lists DISCRETE placements physically at a location, by per-location quantity', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const b = await locations.create({ name: 'Drawer B' });
    const widget = await items.create({ name: 'Widget', quantity: 10, locationId: a.id });
    await items.transferStock(widget.id, a.id, b.id, 4); // 6 @ A, 4 @ B (primary still A)
    const bolt = await items.create({ name: 'Bolt', quantity: 20, locationId: b.id });
    // A serialised instance and a gauge at B must be excluded from the blind quantity count.
    await items.create({ name: 'Meter', trackingMode: 'SERIALISED', locationId: b.id });
    await items.create({
      name: 'Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
      locationId: b.id,
    });

    const atB = await items.listStockAtLocation(b.id);
    // Bolt (20 @ B) then Widget's secondary placement (4 @ B) — busiest first.
    expect(atB).toEqual([
      { itemId: bolt.id, name: 'Bolt', quantity: 20 },
      { itemId: widget.id, name: 'Widget', quantity: 4 },
    ]);
  });

  it('absorbs the variance at the counted placement only, leaving others intact', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const item = await items.create({ name: 'Resistor', quantity: 10, locationId: a.id });
    await items.transferStock(item.id, a.id, b.id, 4); // 6 @ A, 4 @ B, total 10

    // Counted only 3 at B (a shortfall of 1 against the placement's expected 4).
    const [updated] = await items.reconcile([
      { itemId: item.id, counted: 3, note: 'Cycle count of B', locationId: b.id },
    ]);
    expect(updated.quantity).toBe(9); // 6 @ A + 3 @ B

    const placements = await items.listStock(item.id);
    const byLoc = new Map(placements.map((p) => [p.locationId, p.quantity]));
    expect(byLoc.get(a.id)).toBe(6); // untouched
    expect(byLoc.get(b.id)).toBe(3);

    const history = await items.getHistory(item.id);
    const reconciled = history.rows.find((h) => h.action === 'RECONCILED');
    expect(reconciled?.quantityDelta).toBe(-1); // per-location variance, not the total
  });

  it('seeds a placement when a surplus is counted where the item had none', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const item = await items.create({ name: 'Cap', quantity: 5, locationId: a.id });

    await items.reconcile([{ itemId: item.id, counted: 2, note: 'Found 2 at B', locationId: b.id }]);
    expect((await items.getById(item.id))?.quantity).toBe(7); // 5 @ A + a new 2 @ B
    const byLoc = new Map((await items.listStock(item.id)).map((p) => [p.locationId, p.quantity]));
    expect(byLoc.get(b.id)).toBe(2);
  });

  it('a zero per-location variance is a skipped no-op', async () => {
    const a = await locations.create({ name: 'A' });
    const item = await items.create({ name: 'Nut', quantity: 8, locationId: a.id });
    const result = await items.reconcile([
      { itemId: item.id, counted: 8, note: 'matches', locationId: a.id },
    ]);
    expect(result).toHaveLength(0);
  });
});

describe('CheckoutRepository — per-location source (Phase 26)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;
  let checkouts: CheckoutRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    checkouts = new CheckoutRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  async function splitItem() {
    const a = await locations.create({ name: 'Shelf A' });
    const b = await locations.create({ name: 'Shelf B' });
    const item = await items.create({ name: 'Drill', quantity: 10, locationId: a.id });
    await items.transferStock(item.id, a.id, b.id, 4); // 6 @ A, 4 @ B
    return { a, b, item };
  }

  it('decrements the chosen placement, records the source, and returns there', async () => {
    const { a, b, item } = await splitItem();
    const loan = await checkouts.checkout({
      itemId: item.id,
      contactName: 'Sam',
      quantity: 3,
      fromLocationId: b.id,
    });
    expect(loan.sourceLocationId).toBe(b.id);

    let byLoc = new Map((await items.listStock(item.id)).map((p) => [p.locationId, p.quantity]));
    expect(byLoc.get(a.id)).toBe(6); // primary untouched
    expect(byLoc.get(b.id)).toBe(1); // 4 − 3 lent
    expect((await items.getById(item.id))?.quantity).toBe(7);

    await checkouts.checkIn(loan.id);
    byLoc = new Map((await items.listStock(item.id)).map((p) => [p.locationId, p.quantity]));
    expect(byLoc.get(b.id)).toBe(4); // restored to source, not primary
    expect((await items.getById(item.id))?.quantity).toBe(10);
  });

  it('validates availability at the chosen location, not the item total', async () => {
    const { b, item } = await splitItem(); // 4 @ B, total 10
    await expect(
      checkouts.checkout({ itemId: item.id, contactName: 'Sam', quantity: 5, fromLocationId: b.id }),
    ).rejects.toBeInstanceOf(DbError); // 5 > 4 at B even though 10 total
  });

  it('defaults the source to the primary location when none is given', async () => {
    const { a, item } = await splitItem();
    const loan = await checkouts.checkout({ itemId: item.id, contactName: 'Sam', quantity: 2 });
    expect(loan.sourceLocationId).toBe(a.id);
    const byLoc = new Map((await items.listStock(item.id)).map((p) => [p.locationId, p.quantity]));
    expect(byLoc.get(a.id)).toBe(4); // 6 − 2 from primary
  });

  it('falls back to primary when the source location is deleted mid-loan', async () => {
    const { b, item } = await splitItem();
    const loan = await checkouts.checkout({
      itemId: item.id,
      contactName: 'Sam',
      quantity: 3,
      fromLocationId: b.id,
    });
    await locations.delete(b.id); // re-homes B's remaining 1 to Unassigned, nulls the source

    const reloaded = await checkouts.getById(loan.id);
    expect(reloaded?.sourceLocationId).toBeNull();

    await checkouts.checkIn(loan.id); // returns to primary now that the source is gone
    const byLoc = new Map((await items.listStock(item.id)).map((p) => [p.locationName, p.quantity]));
    expect(byLoc.get('Shelf A')).toBe(9); // 6 + 3 returned
    expect((await items.getById(item.id))?.quantity).toBe(10); // 9 @ A + 1 re-homed to Unassigned
  });
});
