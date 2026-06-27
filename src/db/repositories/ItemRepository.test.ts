import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { UNASSIGNED_LOCATION_ID } from './constants';

describe('ItemRepository', () => {
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

  it('creates a discrete item defaulting to Unassigned and logs CREATED', async () => {
    const item = await items.create({ name: 'M3 Screws', quantity: 200 });
    expect(item.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect(item.quantity).toBe(200);
    expect(item.trackingMode).toBe('DISCRETE');

    const history = await items.getHistory(item.id);
    expect(history.rows[0]?.action).toBe('CREATED');
  });

  it('forces SERIALISED items to quantity 1', async () => {
    const printer = await items.create({ name: 'Ender 3', trackingMode: 'SERIALISED', quantity: 5 });
    expect(printer.quantity).toBe(1);
  });

  it('paginates list reads and clamps the limit to 100', async () => {
    for (let i = 0; i < 5; i++) await items.create({ name: `Item ${i}` });
    const page = await items.list({ limit: 1000, offset: 0 });
    expect(page.limit).toBe(100);
    expect(page.rows).toHaveLength(5);
    expect(page.hasMore).toBe(false);

    const firstTwo = await items.list({ limit: 2 });
    expect(firstTwo.rows).toHaveLength(2);
    expect(firstTwo.hasMore).toBe(true);
  });

  it('filters by location and active state', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    await items.create({ name: 'On shelf', locationId: shelf.id });
    const gone = await items.create({ name: 'Removed', locationId: shelf.id });
    await items.softDelete(gone.id);

    const active = await items.list({ locationId: shelf.id });
    expect(active.rows).toHaveLength(1);
    const all = await items.list({ locationId: shelf.id, includeInactive: true });
    expect(all.rows).toHaveLength(2);
  });

  it('adjusts discrete quantity and records the delta', async () => {
    const item = await items.create({ name: 'Resistors', quantity: 100 });
    const updated = await items.adjustQuantity(item.id, -30);
    expect(updated.quantity).toBe(70);

    const history = await items.getHistory(item.id);
    expect(history.rows[0]?.action).toBe('QUANTITY_CHANGE');
    expect(history.rows[0]?.quantityDelta).toBe(-30);
  });

  it('refuses to drive quantity below zero', async () => {
    const item = await items.create({ name: 'Caps', quantity: 5 });
    await expect(items.adjustQuantity(item.id, -10)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
  });

  it('moves an item and logs from/to in the ledger', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    const item = await items.create({ name: 'Box' });
    const moved = await items.move(item.id, shelf.id);
    expect(moved.locationId).toBe(shelf.id);

    const history = await items.getHistory(item.id);
    const moveEntry = history.rows.find((h) => h.action === 'MOVED');
    expect(moveEntry?.metadata).toMatchObject({
      fromLocationId: UNASSIGNED_LOCATION_ID,
      toLocationId: shelf.id,
    });
  });

  it('creates a consumable gauge and computes derived state (§4.1.1)', async () => {
    const spool = await items.create({
      name: 'PLA Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250 },
    });
    expect(spool.gauge?.currentNetValue).toBe(1000); // defaults to full
    expect(spool.gauge?.percentageRemaining).toBe(100);
    expect(spool.gauge?.currentGrossWeight).toBe(1250);
  });

  it('applies a relative gauge consumption and logs the net delta', async () => {
    const spool = await items.create({
      name: 'PETG',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250, currentNetValue: 445 },
    });
    const after = await items.adjustGauge(spool.id, { delta: -45 });
    expect(after.gauge?.currentNetValue).toBe(400);

    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.action).toBe('GAUGE_UPDATE');
    expect(history.rows[0]?.netValueDelta).toBe(-45);
  });

  it('converts an absolute weigh-in to a relative delta before storing (§4.1.2)', async () => {
    const spool = await items.create({
      name: 'Resin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250, currentNetValue: 445 },
    });
    const after = await items.weighInGauge(spool.id, 650);
    expect(after.gauge?.currentNetValue).toBe(400);

    const history = await items.getHistory(spool.id);
    // The ledger stores the *relative* delta, never the absolute scale reading.
    expect(history.rows[0]?.netValueDelta).toBe(-45);
    expect(history.rows[0]?.note).toContain('Calibrated gross weight to 650g');
  });

  it('clamps gauge net value at zero', async () => {
    const spool = await items.create({
      name: 'Nearly empty',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 30 },
    });
    const after = await items.adjustGauge(spool.id, { delta: -100 });
    expect(after.gauge?.currentNetValue).toBe(0);
    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.netValueDelta).toBe(-30); // applied delta, clamped
  });

  it('rejects quantity adjustment on a gauge item', async () => {
    const spool = await items.create({
      name: 'Spool',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });
    await expect(items.adjustQuantity(spool.id, 5)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
  });

  it('soft-deletes (preserving history) and restores', async () => {
    const item = await items.create({ name: 'Multimeter', trackingMode: 'SERIALISED' });
    const removed = await items.softDelete(item.id);
    expect(removed.isActive).toBe(false);

    const restored = await items.restore(item.id);
    expect(restored.isActive).toBe(true);

    const history = await items.getHistory(item.id);
    const actions = history.rows.map((h) => h.action);
    expect(actions).toEqual(expect.arrayContaining(['SOFT_DELETED', 'RESTORED', 'CREATED']));
  });

  it('hard-deletes and cascades the activity log', async () => {
    const item = await items.create({ name: 'Doomed' });
    await items.hardDelete(item.id);
    expect(await items.getById(item.id)).toBeUndefined();
    const history = await items.getHistory(item.id);
    expect(history.rows).toHaveLength(0);
  });

  it('honours the Hard Stop on create but permits soft and hard delete', async () => {
    let locked = false;
    const gated = new ItemRepository(driver, { isWriteSuspended: () => locked });
    const item = await gated.create({ name: 'Temp' });

    locked = true;
    await expect(gated.create({ name: 'Blocked' })).rejects.toMatchObject({
      code: 'WRITE_SUSPENDED',
    });
    // Deletes must still work to free space.
    await expect(gated.softDelete(item.id)).resolves.toMatchObject({ isActive: false });
    await expect(gated.hardDelete(item.id)).resolves.toBeUndefined();
  });
});
