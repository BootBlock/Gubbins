import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { batchKeyOf } from '@/features/inventory/batches';
import { ItemRepository } from './ItemRepository';
import { ProjectRepository } from './ProjectRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { LocationRepository } from './LocationRepository';

/**
 * Explicit per-batch transfer / checkout selection (spec §4 perishables, Phase 29).
 *
 * Phase 28 always drew a placement down first-expiry-first-out. Phase 29 lets the user pick
 * the *exact* lot to move or lend — and a lent lot is remembered on the checkout so the return
 * restores to that exact lot rather than the untracked default batch.
 */
describe('ItemRepository / CheckoutRepository — explicit per-batch selection (Phase 29)', () => {
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

  /** Seed two dated lots (JUN exp 100, AUG exp 200) of `item` at `loc` via received BOM lines. */
  async function seedTwoLots(itemId: string, locationId: string): Promise<void> {
    const project = await projects.create({ name: 'P' });
    for (const [batchNumber, expiryDate, qty] of [
      ['JUN', 100, 5],
      ['AUG', 200, 4],
    ] as const) {
      const line = await projects.addLine(project.id, { itemId, requiredQty: qty });
      await projects.setProcurement(line.id, 'IN_TRANSIT');
      await projects.receiveLine(line.id, {
        locationId,
        quantity: qty,
        batch: { batchNumber, lotNumber: null, expiryDate },
      });
    }
  }

  it('transfers only the chosen lot, leaving the soonest-expiry lot untouched', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const b = await locations.create({ name: 'Drawer B' });
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: a.id });
    await seedTwoLots(item.id, a.id);
    const augKey = batchKeyOf({ batchNumber: 'AUG', lotNumber: null, expiryDate: 200 });

    // Move 3 of AUG specifically — FEFO would have moved JUN first.
    await items.transferStock(item.id, a.id, b.id, 3, augKey);

    const batches = await items.listItemBatches(item.id);
    const at = (loc: string, num: string) =>
      batches.find((x) => x.locationId === loc && x.batchNumber === num)?.quantity;
    expect(at(a.id, 'JUN')).toBe(5); // untouched — not FEFO
    expect(at(a.id, 'AUG')).toBe(1); // 4 − 3
    expect(at(b.id, 'AUG')).toBe(3); // identity preserved at destination
    expect(at(b.id, 'JUN')).toBeUndefined();
    expect((await items.getById(item.id))?.quantity).toBe(9); // total unchanged by a move
  });

  it('clamps a chosen-lot transfer to that lot and never spills into another', async () => {
    const a = await locations.create({ name: 'Drawer A' });
    const b = await locations.create({ name: 'Drawer B' });
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: a.id });
    await seedTwoLots(item.id, a.id);
    const augKey = batchKeyOf({ batchNumber: 'AUG', lotNumber: null, expiryDate: 200 });

    // Ask for 10 of AUG (only 4 there): exactly 4 move, JUN is never touched.
    await items.transferStock(item.id, a.id, b.id, 10, augKey);

    const batches = await items.listItemBatches(item.id);
    expect(batches.find((x) => x.locationId === a.id && x.batchNumber === 'JUN')?.quantity).toBe(5);
    expect(batches.find((x) => x.locationId === a.id && x.batchNumber === 'AUG')).toBeUndefined();
    expect(batches.find((x) => x.locationId === b.id && x.batchNumber === 'AUG')?.quantity).toBe(4);
  });

  it('lends a chosen lot (not FEFO), records it, and returns it to that exact lot', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawer.id });
    await seedTwoLots(item.id, drawer.id);
    const augKey = batchKeyOf({ batchNumber: 'AUG', lotNumber: null, expiryDate: 200 });
    const contact = await contacts.create({ name: 'Alex' });

    // Lend 2 of AUG specifically — FEFO would have drawn JUN.
    const co = await checkouts.checkout({
      itemId: item.id,
      contactId: contact.id,
      quantity: 2,
      fromLocationId: drawer.id,
      fromBatchKey: augKey,
    });
    expect(co.sourceBatchKey).toBe(augKey);

    let batches = await items.listItemBatches(item.id);
    expect(batches.find((b) => b.batchNumber === 'JUN')?.quantity).toBe(5); // untouched
    expect(batches.find((b) => b.batchNumber === 'AUG')?.quantity).toBe(2); // 4 − 2

    // Return restores to the AUG lot, not the untracked default batch.
    await checkouts.checkIn(co.id);
    batches = await items.listItemBatches(item.id);
    expect(batches.find((b) => b.batchNumber === 'AUG')?.quantity).toBe(4); // back to full
    expect(batches.some((b) => b.batchKey === '')).toBe(false); // no anonymous remainder created
    expect((await items.getById(item.id))?.quantity).toBe(9);
  });

  it('rejects lending more of a lot than it holds', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawer.id });
    await seedTwoLots(item.id, drawer.id);
    const augKey = batchKeyOf({ batchNumber: 'AUG', lotNumber: null, expiryDate: 200 });
    const contact = await contacts.create({ name: 'Alex' });

    await expect(
      checkouts.checkout({
        itemId: item.id,
        contactId: contact.id,
        quantity: 5, // AUG only has 4
        fromLocationId: drawer.id,
        fromBatchKey: augKey,
      }),
    ).rejects.toThrow(/chosen lot/i);
    // Nothing was drawn — both lots intact.
    expect((await items.getById(item.id))?.quantity).toBe(9);
  });

  it('without a chosen lot, keeps the Phase-28 FEFO behaviour and records no source lot', async () => {
    const drawer = await locations.create({ name: 'Drawer A' });
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawer.id });
    await seedTwoLots(item.id, drawer.id);
    const contact = await contacts.create({ name: 'Alex' });

    const co = await checkouts.checkout({
      itemId: item.id,
      contactId: contact.id,
      quantity: 2,
      fromLocationId: drawer.id,
    });
    expect(co.sourceBatchKey).toBeNull();
    const batches = await items.listItemBatches(item.id);
    expect(batches.find((b) => b.batchNumber === 'JUN')?.quantity).toBe(3); // FEFO drew JUN
    expect(batches.find((b) => b.batchNumber === 'AUG')?.quantity).toBe(4);
  });
});
