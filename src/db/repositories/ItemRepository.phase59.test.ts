import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';

/**
 * Phase 59 — per-item reorder points. `listLowStock` now resolves each row's floor
 * from its own `reorder_point` / `reorder_gauge_percent`, falling back per row to the
 * passed-in global threshold; create/update round-trip the override columns.
 */
describe('ItemRepository — per-item reorder points (Phase 59)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('round-trips the reorder columns through create and getById', async () => {
    const created = await items.create({
      name: 'Connector',
      trackingMode: 'DISCRETE',
      quantity: 3,
      reorderPoint: 20,
      reorderQty: 50,
    });
    expect(created.reorderPoint).toBe(20);
    expect(created.reorderQty).toBe(50);
    expect(created.reorderGaugePercent).toBeNull();

    const fetched = await items.getById(created.id);
    expect(fetched?.reorderPoint).toBe(20);
    expect(fetched?.reorderQty).toBe(50);
  });

  it('defaults the reorder columns to null when not supplied (no regression)', async () => {
    const created = await items.create({ name: 'Screw', trackingMode: 'DISCRETE', quantity: 100 });
    expect(created.reorderPoint).toBeNull();
    expect(created.reorderGaugePercent).toBeNull();
    expect(created.reorderQty).toBeNull();
  });

  it('updates and clears a reorder point', async () => {
    const created = await items.create({ name: 'Bolt', trackingMode: 'DISCRETE', quantity: 4 });
    const set = await items.update(created.id, { reorderPoint: 10 });
    expect(set.reorderPoint).toBe(10);
    const cleared = await items.update(created.id, { reorderPoint: null });
    expect(cleared.reorderPoint).toBeNull();
  });

  it('flags a DISCRETE item by its own higher reorder point (global would not flag)', async () => {
    // Global default is 5; 15 on-hand is healthy globally, but this part wants 20.
    await items.create({ name: 'Bespoke', trackingMode: 'DISCRETE', quantity: 15, reorderPoint: 20 });
    await items.create({ name: 'Common', trackingMode: 'DISCRETE', quantity: 15 });

    const page = await items.listLowStock();
    expect(page.rows.map((r) => r.name)).toEqual(['Bespoke']);
  });

  it('does NOT flag a DISCRETE item whose own reorder point sits below on-hand', async () => {
    // Global default 5 would flag qty 3, but this part only re-orders at/below 2.
    await items.create({ name: 'Relaxed', trackingMode: 'DISCRETE', quantity: 3, reorderPoint: 2 });
    await items.create({ name: 'Default', trackingMode: 'DISCRETE', quantity: 3 });

    const page = await items.listLowStock();
    expect(page.rows.map((r) => r.name)).toEqual(['Default']);
  });

  it('flags a CONSUMABLE_GAUGE item by its own gauge percentage override', async () => {
    // Global gauge default 15%; this resin at 30% is fine globally but wants 40%.
    await items.create({
      name: 'PickyResin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 300 }, // 30%
      reorderGaugePercent: 40,
    });
    await items.create({
      name: 'NormalResin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 300 }, // 30%
    });

    const page = await items.listLowStock();
    expect(page.rows.map((r) => r.name)).toEqual(['PickyResin']);
  });

  it('mixes per-item and global rows, most urgent (relative to its own floor) first', async () => {
    // 8/20 = 0.40 of its bespoke floor; 2/5 (global) = 0.40; 1/5 (global) = 0.20.
    await items.create({ name: 'Bespoke20', trackingMode: 'DISCRETE', quantity: 8, reorderPoint: 20 });
    await items.create({ name: 'GlobalTwo', trackingMode: 'DISCRETE', quantity: 2 });
    await items.create({ name: 'GlobalOne', trackingMode: 'DISCRETE', quantity: 1 });
    await items.create({ name: 'Healthy', trackingMode: 'DISCRETE', quantity: 100 });

    const page = await items.listLowStock();
    // GlobalOne (0.20) is most urgent; the two 0.40 rows tie and fall back to name order.
    expect(page.rows.map((r) => r.name)).toEqual(['GlobalOne', 'Bespoke20', 'GlobalTwo']);
  });

  it('treats a reorder point of 0 as "only flag when empty" without dividing by zero', async () => {
    await items.create({ name: 'OnlyWhenEmpty', trackingMode: 'DISCRETE', quantity: 0, reorderPoint: 0 });
    await items.create({ name: 'StillHasOne', trackingMode: 'DISCRETE', quantity: 1, reorderPoint: 0 });

    const page = await items.listLowStock();
    expect(page.rows.map((r) => r.name)).toEqual(['OnlyWhenEmpty']);
  });

  it('rejects a negative reorder point', async () => {
    await expect(
      items.create({ name: 'Bad', trackingMode: 'DISCRETE', quantity: 1, reorderPoint: -1 }),
    ).rejects.toThrow();
  });

  it('rejects an out-of-range reorder gauge percentage', async () => {
    await expect(
      items.create({
        name: 'BadPct',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
        reorderGaugePercent: 150,
      }),
    ).rejects.toThrow();
  });
});
