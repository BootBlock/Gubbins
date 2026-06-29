import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { ProjectRepository } from './ProjectRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { LocationRepository } from './LocationRepository';

/**
 * Batch / lot-aware per-location stock (spec §4 perishables & traceability, Phase 28).
 * `stock_batches` is the SSOT below `item_stock`: a placement's units can split across
 * lots, item_stock.quantity = SUM(batches) and items.quantity = SUM(item_stock) flow via
 * the recompute triggers. These cover the new surface — batch-aware receiving, FEFO
 * consumption on checkout/transfer, per-batch cycle count, and the breakdown reads.
 */
describe('ItemRepository — batch-aware stock (Phase 28)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let projects: ProjectRepository;
  let checkouts: CheckoutRepository;
  let contacts: ContactRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    projects = new ProjectRepository(driver);
    checkouts = new CheckoutRepository(driver);
    contacts = new ContactRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('seeds a single untracked default batch on create', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Gel', quantity: 10, locationId: drawer.id });
    const batches = await items.listItemBatches(item.id);
    expect(batches).toEqual([
      {
        locationId: drawer.id,
        locationName: 'Drawer A',
        batchKey: '',
        batchNumber: null,
        lotNumber: null,
        expiryDate: null,
        quantity: 10,
      },
    ]);
    expect(item.quantity).toBe(10);
  });

  it('receives a BOM line into a specific lot, splitting the placement by batch', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Adhesive', quantity: 4, locationId: drawer.id });
    const project = await projects.create({ name: 'Build' });
    const line = await projects.addLine(project.id, { itemId: item.id, requiredQty: 6 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');

    await projects.receiveLine(line.id, {
      locationId: drawer.id,
      quantity: 6,
      batch: { batchNumber: 'B-22', lotNumber: null, expiryDate: 200 },
    });

    const refreshed = await items.getById(item.id);
    expect(refreshed?.quantity).toBe(10); // 4 untracked + 6 in lot B-22
    const batches = await items.listItemBatches(item.id);
    expect(batches).toHaveLength(2);
    // FEFO order: the dated lot (expiry 200) sorts before the untracked remainder.
    expect(batches[0]).toMatchObject({ batchNumber: 'B-22', expiryDate: 200, quantity: 6 });
    expect(batches[1]).toMatchObject({ batchKey: '', quantity: 4 });
  });

  it('draws a checkout down first-expiry-first-out across lots', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawer.id });
    const project = await projects.create({ name: 'P' });
    // Two dated lots: June (expiry 100) and August (expiry 200).
    for (const [batchNumber, expiryDate] of [
      ['JUN', 100],
      ['AUG', 200],
    ] as const) {
      const line = await projects.addLine(project.id, { itemId: item.id, requiredQty: 5 });
      await projects.setProcurement(line.id, 'IN_TRANSIT');
      await projects.receiveLine(line.id, {
        locationId: drawer.id,
        quantity: 5,
        batch: { batchNumber, lotNumber: null, expiryDate },
      });
    }
    const contact = await contacts.create({ name: 'Alex' });

    // Lend 7: the soonest-expiring lot (JUN, 5) goes first, then 2 from AUG.
    await checkouts.checkout({ itemId: item.id, contactId: contact.id, quantity: 7, fromLocationId: drawer.id });

    const batches = await items.listItemBatches(item.id);
    const byNum = new Map(batches.map((b) => [b.batchNumber, b.quantity]));
    expect(byNum.get('JUN')).toBeUndefined(); // fully drawn (0 → filtered out)
    expect(byNum.get('AUG')).toBe(3);
    expect((await items.getById(item.id))?.quantity).toBe(3);
  });

  it('preserves each lot identity when transferring stock between locations', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const b = await locations.create({ name: 'Drawer B' });
    const item = await items.create({ name: 'Film', quantity: 0, locationId: a.id });
    const project = await projects.create({ name: 'P' });
    const line = await projects.addLine(project.id, { itemId: item.id, requiredQty: 8 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');
    await projects.receiveLine(line.id, {
      locationId: a.id,
      quantity: 8,
      batch: { batchNumber: 'L1', lotNumber: null, expiryDate: 150 },
    });

    await items.transferStock(item.id, a.id, b.id, 3);

    const batches = await items.listItemBatches(item.id);
    const atB = batches.filter((x) => x.locationId === b.id);
    expect(atB).toHaveLength(1);
    expect(atB[0]).toMatchObject({ batchNumber: 'L1', expiryDate: 150, quantity: 3 });
    expect(batches.find((x) => x.locationId === a.id)).toMatchObject({ batchNumber: 'L1', quantity: 5 });
    expect((await items.getById(item.id))?.quantity).toBe(8); // total preserved
  });

  it('reconciles a single lot at a placement, absorbing the variance at that batch', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Strips', quantity: 0, locationId: drawer.id });
    const project = await projects.create({ name: 'P' });
    const line = await projects.addLine(project.id, { itemId: item.id, requiredQty: 10 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');
    const batch = { batchNumber: 'LOT9', lotNumber: null, expiryDate: 300 };
    await projects.receiveLine(line.id, { locationId: drawer.id, quantity: 10, batch });

    // Blind count finds only 7 of LOT9.
    await items.reconcile([
      { itemId: item.id, counted: 7, note: 'Audit LOT9', locationId: drawer.id, batch },
    ]);

    const batches = await items.listItemBatches(item.id);
    expect(batches.find((b) => b.batchNumber === 'LOT9')?.quantity).toBe(7);
    expect((await items.getById(item.id))?.quantity).toBe(7);
    const history = await items.getHistory(item.id);
    const reconciled = history.rows.find((h) => h.action === 'RECONCILED');
    expect(reconciled?.quantityDelta).toBe(-3);
  });

  it('lists DISCRETE batches at a location for the batch-aware cycle count', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Tape', quantity: 2, locationId: drawer.id });
    const project = await projects.create({ name: 'P' });
    const line = await projects.addLine(project.id, { itemId: item.id, requiredQty: 3 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');
    await projects.receiveLine(line.id, {
      locationId: drawer.id,
      quantity: 3,
      batch: { batchNumber: 'T1', lotNumber: null, expiryDate: 120 },
    });

    const lines = await items.listStockBatchesAtLocation(drawer.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ batchNumber: 'T1', expiryDate: 120, quantity: 3 }); // FEFO: dated first
    expect(lines[1]).toMatchObject({ batchKey: '', quantity: 2 });
  });

  it('re-homes batches to Unassigned (preserving lots) when their location is deleted', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Vial', quantity: 0, locationId: drawer.id });
    const project = await projects.create({ name: 'P' });
    const line = await projects.addLine(project.id, { itemId: item.id, requiredQty: 4 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');
    await projects.receiveLine(line.id, {
      locationId: drawer.id,
      quantity: 4,
      batch: { batchNumber: 'V7', lotNumber: null, expiryDate: 90 },
    });
    // Move the item's primary elsewhere so deleting Drawer A is allowed, then delete it.
    const home = await locations.create({ name: 'Home' });
    await items.move(item.id, home.id);
    // After the move, all 4 consolidated to Home; receive again at the doomed drawer.
    const line2 = await projects.addLine(project.id, { itemId: item.id, requiredQty: 2 });
    await projects.setProcurement(line2.id, 'IN_TRANSIT');
    await projects.receiveLine(line2.id, {
      locationId: drawer.id,
      quantity: 2,
      batch: { batchNumber: 'V8', lotNumber: null, expiryDate: 80 },
    });

    await locations.delete(drawer.id);

    const batches = await items.listItemBatches(item.id);
    expect(batches.some((b) => b.locationId === drawer.id)).toBe(false);
    // The V8 lot survived, re-homed to Unassigned, identity intact.
    expect(batches.find((b) => b.batchNumber === 'V8')?.quantity).toBe(2);
    expect((await items.getById(item.id))?.quantity).toBe(6); // 4 (V7) at Home + 2 (V8) re-homed
  });
});
