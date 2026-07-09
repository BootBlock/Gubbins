import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

/**
 * Sell / write-off outbound movements (Sales & disposals capability). Both draw DISCRETE stock
 * permanently out of inventory via the shared FEFO/lot decrement and log a ledger entry carrying
 * the sale price / cost snapshot the sales report reads.
 */
describe('ItemRepository — sell & write-off', () => {
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

  it('sells units, dropping stock and logging a SOLD entry with proceeds and a cost snapshot', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Widget', quantity: 10, locationId: drawer.id, unitCost: 2 });

    const after = await items.sell({ itemId: item.id, quantity: 3, unitSalePrice: 5 });
    expect(after.quantity).toBe(7);

    const history = await items.getHistory(item.id);
    const sold = history.rows.find((h) => h.action === 'SOLD');
    expect(sold).toBeDefined();
    expect(sold!.quantityDelta).toBe(-3);
    expect(sold!.netValueDelta).toBe(15); // 3 × 5
    expect(sold!.metadata).toMatchObject({ quantity: 3, unitSalePrice: 5, saleTotal: 15, unitCostAtSale: 2 });
  });

  it('records the buyer counterparty on the ledger entry', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Widget', quantity: 5, locationId: drawer.id });
    await items.sell({ itemId: item.id, quantity: 1, unitSalePrice: 9, counterparty: 'Acme Ltd' });
    const history = await items.getHistory(item.id);
    const sold = history.rows.find((h) => h.action === 'SOLD');
    expect(sold!.metadata).toMatchObject({ counterparty: 'Acme Ltd' });
  });

  it('rejects selling more than is on hand', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Widget', quantity: 2, locationId: drawer.id });
    await expect(items.sell({ itemId: item.id, quantity: 5, unitSalePrice: 1 })).rejects.toBeInstanceOf(
      DbError,
    );
    // Stock is untouched after a rejected sale.
    expect((await items.getById(item.id))!.quantity).toBe(2);
  });

  it('rejects a negative sale price', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Widget', quantity: 5, locationId: drawer.id });
    await expect(items.sell({ itemId: item.id, quantity: 1, unitSalePrice: -1 })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('writes off units with no proceeds and an optional reason', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Widget', quantity: 8, locationId: drawer.id, unitCost: 3 });

    const after = await items.writeOff({ itemId: item.id, quantity: 2, reason: 'Damaged' });
    expect(after.quantity).toBe(6);

    const history = await items.getHistory(item.id);
    const written = history.rows.find((h) => h.action === 'WRITTEN_OFF');
    expect(written).toBeDefined();
    expect(written!.quantityDelta).toBe(-2);
    expect(written!.netValueDelta).toBeNull();
    expect(written!.metadata).toMatchObject({ quantity: 2, reason: 'Damaged', unitCostAtSale: 3 });
  });

  it('refuses to sell a non-DISCRETE item', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const serial = await items.create({ name: 'Camera', trackingMode: 'SERIALISED', locationId: drawer.id });
    await expect(items.sell({ itemId: serial.id, quantity: 1, unitSalePrice: 100 })).rejects.toBeInstanceOf(
      DbError,
    );
  });
});
