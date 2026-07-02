import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

/**
 * Per-location stock ledger (spec §4, Phase 25). `item_stock` is the SSOT for *where*
 * an item's units sit; `items.quantity` is the derived sum maintained by the recompute
 * triggers. These cover the new multi-location surface: split, transfer, breakdown.
 */
describe('ItemRepository — per-location stock ledger (Phase 25)', () => {
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

  it('seeds a single primary placement on create that equals the total', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Resistor', quantity: 60, locationId: drawer.id });
    const placements = await items.listStock(item.id);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ locationId: drawer.id, quantity: 60 });
    expect(item.quantity).toBe(60);
  });

  it('transfers part of the stock to a second location, leaving the total unchanged', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const b = await locations.create({ name: 'Drawer B' });
    const item = await items.create({ name: 'Resistor', quantity: 100, locationId: a.id });

    const after = await items.transferStock(item.id, a.id, b.id, 40);
    expect(after.quantity).toBe(100); // total preserved — units only moved
    expect(after.locationId).toBe(a.id); // primary unchanged

    const placements = await items.listStock(item.id);
    expect(placements).toEqual([
      { locationId: a.id, locationName: 'Drawer A', quantity: 60 },
      { locationId: b.id, locationName: 'Drawer B', quantity: 40 },
    ]);
    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'MOVED')).toBe(true);
  });

  it('clamps a transfer to the available stock and rejects an empty/invalid one', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const item = await items.create({ name: 'Cap', quantity: 5, locationId: a.id });

    await items.transferStock(item.id, a.id, b.id, 999); // clamped to 5
    const placements = await items.listStock(item.id);
    expect(placements.find((p) => p.locationId === b.id)?.quantity).toBe(5);
    expect(placements.find((p) => p.locationId === a.id)).toBeUndefined(); // emptied → filtered

    // Nothing left at A to transfer.
    await expect(items.transferStock(item.id, a.id, b.id, 1)).rejects.toBeInstanceOf(DbError);
    // Same source/destination is rejected.
    await expect(items.transferStock(item.id, b.id, b.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('consolidates every placement when the whole item is moved', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const c = await locations.create({ name: 'C' });
    const item = await items.create({ name: 'Widget', quantity: 10, locationId: a.id });
    await items.transferStock(item.id, a.id, b.id, 4); // 6 @ A, 4 @ B

    const moved = await items.move(item.id, c.id);
    expect(moved.locationId).toBe(c.id);
    expect(moved.quantity).toBe(10);
    const placements = await items.listStock(item.id);
    expect(placements).toEqual([{ locationId: c.id, locationName: 'C', quantity: 10 }]);
  });

  it('refuses to split a non-DISCRETE item', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const gauge = await items.create({
      name: 'Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
      locationId: a.id,
    });
    await expect(items.transferStock(gauge.id, a.id, b.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('re-homes placements to Unassigned when their location is deleted', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const item = await items.create({ name: 'Bolt', quantity: 10, locationId: a.id });
    await items.transferStock(item.id, a.id, b.id, 4); // 6 @ A, 4 @ B

    await locations.delete(b.id); // the 4 at B must survive, re-homed
    const after = await items.getById(item.id);
    expect(after?.quantity).toBe(10);
    const placements = await items.listStock(item.id);
    const byLoc = new Map(placements.map((p) => [p.locationName, p.quantity]));
    expect(byLoc.get('A')).toBe(6);
    expect(byLoc.get('Unassigned')).toBe(4);
  });
});
