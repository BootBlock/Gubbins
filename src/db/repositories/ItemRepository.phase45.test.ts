import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';

/**
 * Phase 45 — the §3 dashboard "Low Stock Alerts" widget feed. A DISCRETE item is low
 * when on-hand `quantity` is at/below the threshold; a CONSUMABLE_GAUGE item is low
 * when its percentage remaining is at/below the gauge threshold. SERIALISED single
 * assets and abstract variant parents are excluded; inactive items are excluded;
 * results are ordered most-depleted first.
 */
describe('ItemRepository.listLowStock — §3 Low Stock Alerts (Phase 45)', () => {
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

  it('lists low discrete + low gauge items, most depleted first, active only', async () => {
    await items.create({ name: 'LowQty', trackingMode: 'DISCRETE', quantity: 2 });
    await items.create({ name: 'Plenty', trackingMode: 'DISCRETE', quantity: 50 });
    await items.create({ name: 'Empty', trackingMode: 'DISCRETE', quantity: 0 });
    await items.create({
      name: 'LowResin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 100 }, // 10%
    });
    await items.create({
      name: 'FullFilament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 800 }, // 80%
    });
    // SERIALISED single assets are forced to qty 1 but are not "low bulk stock".
    await items.create({ name: 'Printer', trackingMode: 'SERIALISED' });
    const gone = await items.create({ name: 'GoneLow', trackingMode: 'DISCRETE', quantity: 1 });
    await items.softDelete(gone.id);

    const page = await items.listLowStock();
    // Empty (0/5), LowResin (10%), LowQty (2/5) — Plenty/Full/Printer/Gone excluded.
    expect(page.rows.map((r) => r.name)).toEqual(['Empty', 'LowResin', 'LowQty']);
  });

  it('honours custom thresholds', async () => {
    await items.create({ name: 'Eight', trackingMode: 'DISCRETE', quantity: 8 });
    await items.create({
      name: 'HalfFull',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 450 }, // 45%
    });

    const tight = await items.listLowStock();
    expect(tight.rows.map((r) => r.name)).toEqual([]); // 8 > 5 and 45% > 15%

    const loose = await items.listLowStock({ qtyThreshold: 10, gaugePercent: 50 });
    expect(loose.rows.map((r) => r.name).sort()).toEqual(['Eight', 'HalfFull']);
  });

  it('excludes abstract variant parents but includes their low variants', async () => {
    const parent = await items.create({ name: 'Resistor 0805' }); // qty 0, abstract once it has a child
    await items.createVariant(parent.id, { name: '10k', quantity: 1 });

    const page = await items.listLowStock();
    expect(page.rows.map((r) => r.name)).toEqual(['10k']);
  });
});
