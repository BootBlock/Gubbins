import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { PurchaseOrderRepository } from './PurchaseOrderRepository';
import { SupplierPartRepository } from './SupplierPartRepository';

describe('PurchaseOrderRepository (spec §4 Formal Purchase Orders)', () => {
  let driver: MemoryDriver;
  let pos: PurchaseOrderRepository;
  let items: ItemRepository;
  let locations: LocationRepository;
  let supplierParts: SupplierPartRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    pos = new PurchaseOrderRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    supplierParts = new SupplierPartRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  // --- creation & lines ----------------------------------------------------------

  it('creates a DRAFT purchase order, trimming the supplier name', async () => {
    const po = await pos.create({ supplierName: '  DigiKey  ', reference: 'PO-1' });
    expect(po.supplierName).toBe('DigiKey');
    expect(po.reference).toBe('PO-1');
    expect(po.status).toBe('DRAFT');
    expect(po.orderedAt).toBeNull();
  });

  it('rejects a blank supplier name and a non-positive ordered quantity', async () => {
    await expect(pos.create({ supplierName: '   ' })).rejects.toBeInstanceOf(DbError);
    const po = await pos.create({ supplierName: 'RS' });
    await expect(pos.addLine(po.id, { orderedQty: 0 })).rejects.toBeInstanceOf(DbError);
    await expect(pos.addLine(po.id, { orderedQty: 2.5 })).rejects.toBeInstanceOf(DbError);
  });

  it('adds, lists, updates and removes lines', async () => {
    const item = await items.create({ name: 'Cap' });
    const po = await pos.create({ supplierName: 'Mouser' });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 10, unitCost: 0.2 });
    expect((await pos.listLines(po.id))).toHaveLength(1);

    const updated = await pos.updateLine(line.id, { orderedQty: 12 });
    expect(updated.orderedQty).toBe(12);

    await pos.removeLine(line.id);
    expect(await pos.listLines(po.id)).toHaveLength(0);
  });

  // --- derived status ------------------------------------------------------------

  it('keeps a DRAFT order DRAFT even with fully-received lines', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplierName: 'RS' });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 3 });
    // Receiving against a still-DRAFT PO updates the line but the persisted status stays DRAFT.
    await pos.receiveLine(line.id);
    const withLines = await pos.getWithLines(po.id);
    expect(withLines?.status).toBe('DRAFT');
    expect(withLines?.effectiveStatus).toBe('DRAFT');
  });

  it('moving to ORDERED stamps ordered_at and surfaces ORDERED before any receipt', async () => {
    const item = await items.create({ name: 'IC' });
    const po = await pos.create({ supplierName: 'RS' });
    await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    const ordered = await pos.setStatus(po.id, 'ORDERED');
    expect(ordered.status).toBe('ORDERED');
    expect(ordered.orderedAt).not.toBeNull();
  });

  it('a partial receipt lands stock and derives PARTIAL; the remainder derives RECEIVED', async () => {
    const item = await items.create({ name: 'IC', quantity: 1 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplierName: 'Farnell' });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 5 });
    await pos.setStatus(po.id, 'ORDERED');

    // Partial: 2 of 5 → on-hand rises by 2, PO derives PARTIAL.
    const partial = await pos.receiveLine(line.id, { locationId: shelf.id, quantity: 2 });
    expect(partial.receivedQty).toBe(2);
    expect((await items.getById(item.id))?.quantity).toBe(3); // 1 + 2
    const afterPartial = await pos.getWithLines(po.id);
    expect(afterPartial?.status).toBe('PARTIAL');
    expect(afterPartial?.effectiveStatus).toBe('PARTIAL');
    const placements = await items.listStock(item.id);
    expect(placements.find((s) => s.locationId === shelf.id)?.quantity).toBe(2);

    // Remainder (default = 3) → fully received, PO derives RECEIVED.
    const done = await pos.receiveLine(line.id, { locationId: shelf.id });
    expect(done.receivedQty).toBe(5);
    expect((await items.getById(item.id))?.quantity).toBe(6); // 3 + 3
    const afterAll = await pos.getWithLines(po.id);
    expect(afterAll?.status).toBe('RECEIVED');
    expect(afterAll?.effectiveStatus).toBe('RECEIVED');

    const history = await items.getHistory(item.id);
    expect(history.rows.filter((h) => h.action === 'RECEIVED')).toHaveLength(2);
  });

  it('logs a RECEIVED history entry on a matched discrete receipt', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplierName: 'RS' });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id);
    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RECEIVED')).toBe(true);
  });

  // --- on-order projection -------------------------------------------------------

  it('projects on-order quantity only for active (non-DRAFT/CANCELLED) orders', async () => {
    const item = await items.create({ name: 'IC' });
    const po = await pos.create({ supplierName: 'RS' });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 10 });

    // DRAFT → nothing on order yet.
    expect(await pos.onOrderQtyForItem(item.id)).toBe(0);

    await pos.setStatus(po.id, 'ORDERED');
    expect(await pos.onOrderQtyForItem(item.id)).toBe(10);

    // A partial receipt reduces the outstanding figure.
    await pos.receiveLine(line.id, { quantity: 4 });
    expect(await pos.onOrderQtyForItem(item.id)).toBe(6);

    // Cancelling the order drops it from the projection.
    await pos.setStatus(po.id, 'CANCELLED');
    expect(await pos.onOrderQtyForItem(item.id)).toBe(0);
  });

  // --- FK SET NULL on the supplier-part link -------------------------------------

  it('NULLs a line supplier_part_id when the supplier part is deleted, keeping the line', async () => {
    const item = await items.create({ name: 'Resistor' });
    const sp = await supplierParts.create(item.id, { supplierName: 'DigiKey', orderCode: 'R-1' });
    const po = await pos.create({ supplierName: 'DigiKey' });
    const line = await pos.addLine(po.id, {
      itemId: item.id,
      supplierPartId: sp.id,
      orderedQty: 3,
    });
    expect((await pos.getLine(line.id))?.supplierPartId).toBe(sp.id);

    await supplierParts.delete(sp.id);
    const after = await pos.getLine(line.id);
    expect(after).toBeDefined();
    expect(after?.supplierPartId).toBeNull();
  });

  // --- cascade delete ------------------------------------------------------------

  it('cascades lines when the purchase order is deleted', async () => {
    const item = await items.create({ name: 'IC' });
    const po = await pos.create({ supplierName: 'RS' });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 5 });
    await pos.delete(po.id);
    expect(await pos.getById(po.id)).toBeUndefined();
    expect(await pos.getLine(line.id)).toBeUndefined();
  });
});
