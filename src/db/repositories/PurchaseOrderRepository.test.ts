import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import {
  isReceivedQtyGuardViolation,
  PO_RECEIPT_RACE_MESSAGE,
  PurchaseOrderRepository,
} from './PurchaseOrderRepository';
import { SupplierPartRepository } from './SupplierPartRepository';
import { SupplierRepository } from './SupplierRepository';

describe('PurchaseOrderRepository (spec §4 Formal Purchase Orders)', () => {
  let driver: MemoryDriver;
  let pos: PurchaseOrderRepository;
  let items: ItemRepository;
  let locations: LocationRepository;
  let supplierParts: SupplierPartRepository;
  let suppliers: SupplierRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    pos = new PurchaseOrderRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    supplierParts = new SupplierPartRepository(driver);
    suppliers = new SupplierRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  // --- creation & lines ----------------------------------------------------------

  it('creates a DRAFT purchase order, trimming the supplier name', async () => {
    const po = await pos.create({ supplier: { supplierName: '  DigiKey  ' }, reference: 'PO-1' });
    expect(po.supplierName).toBe('DigiKey');
    expect(po.reference).toBe('PO-1');
    expect(po.status).toBe('DRAFT');
    expect(po.orderedAt).toBeNull();
  });

  it('rejects a blank supplier name and a non-positive ordered quantity', async () => {
    await expect(pos.create({ supplier: { supplierName: '   ' } })).rejects.toBeInstanceOf(DbError);
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    await expect(pos.addLine(po.id, { orderedQty: 0 })).rejects.toBeInstanceOf(DbError);
    await expect(pos.addLine(po.id, { orderedQty: 2.5 })).rejects.toBeInstanceOf(DbError);
  });

  it('adds, lists, updates and removes lines', async () => {
    const item = await items.create({ name: 'Cap' });
    const po = await pos.create({ supplier: { supplierName: 'Mouser' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 10, unitCost: 0.2 });
    expect(await pos.listLines(po.id)).toHaveLength(1);

    const updated = await pos.updateLine(line.id, { orderedQty: 12 });
    expect(updated.orderedQty).toBe(12);

    await pos.removeLine(line.id);
    expect(await pos.listLines(po.id)).toHaveLength(0);
  });

  it('counts every order, including those past the capped first page (issue #149)', async () => {
    expect(await pos.count()).toBe(0);

    for (let i = 0; i < 102; i += 1) {
      await pos.create({ supplier: { supplierName: 'Mouser' }, reference: `PO-${i}` });
    }

    // The list is clamped to the strict §2.1 ceiling, so the rows in hand undercount the set —
    // which is exactly why the Orders tab needs a separate total to page against.
    const firstPage = await pos.list({ limit: 100 });
    expect(firstPage.rows).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);
    expect(await pos.count()).toBe(102);

    // The second page reaches the orders the old single-read screen could never show.
    const secondPage = await pos.list({ limit: 100, offset: 100 });
    expect(secondPage.rows).toHaveLength(2);
    expect(secondPage.hasMore).toBe(false);
  });

  // --- derived status ------------------------------------------------------------

  it('keeps a DRAFT order DRAFT even with fully-received lines', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 3 });
    // Receiving against a still-DRAFT PO updates the line but the persisted status stays DRAFT.
    await pos.receiveLine(line.id);
    const withLines = await pos.getWithLines(po.id);
    expect(withLines?.status).toBe('DRAFT');
    expect(withLines?.effectiveStatus).toBe('DRAFT');
  });

  it('moving to ORDERED stamps ordered_at and surfaces ORDERED before any receipt', async () => {
    const item = await items.create({ name: 'IC' });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    const ordered = await pos.setStatus(po.id, 'ORDERED');
    expect(ordered.status).toBe('ORDERED');
    expect(ordered.orderedAt).not.toBeNull();
  });

  it('a partial receipt lands stock and derives PARTIAL; the remainder derives RECEIVED', async () => {
    const item = await items.create({ name: 'IC', quantity: 1 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplier: { supplierName: 'Farnell' } });
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
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id);
    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RECEIVED')).toBe(true);
  });

  // --- returns to supplier (inverse of receive) ----------------------------------

  it('returns received stock to the supplier, dropping stock and re-deriving PARTIAL', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplier: { supplierName: 'Farnell' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 5, unitCost: 2 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id, { locationId: shelf.id }); // receive all 5 → RECEIVED
    expect((await pos.getWithLines(po.id))?.effectiveStatus).toBe('RECEIVED');

    // Return 2 of the 5 from the shelf they landed on.
    const afterReturn = await pos.returnLine(line.id, { locationId: shelf.id, quantity: 2 });
    expect(afterReturn.receivedQty).toBe(3);
    expect((await items.getById(item.id))?.quantity).toBe(3); // 5 − 2
    const po2 = await pos.getWithLines(po.id);
    expect(po2?.effectiveStatus).toBe('PARTIAL'); // received (3) < ordered (5)

    const history = await items.getHistory(item.id);
    const returned = history.rows.find((h) => h.action === 'RETURNED_TO_SUPPLIER');
    expect(returned).toBeDefined();
    expect(returned!.quantityDelta).toBe(-2);
    expect(returned!.metadata).toMatchObject({ supplierName: 'Farnell', unitCost: 2 });
  });

  it('defaults to returning everything received and re-derives ORDERED', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id, { locationId: shelf.id });

    const afterReturn = await pos.returnLine(line.id, { locationId: shelf.id });
    expect(afterReturn.receivedQty).toBe(0);
    expect((await items.getById(item.id))?.quantity).toBe(0);
    expect((await pos.getWithLines(po.id))?.effectiveStatus).toBe('ORDERED');
  });

  it('rejects returning a line with nothing received', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(po.id, 'ORDERED');
    await expect(pos.returnLine(line.id)).rejects.toBeInstanceOf(DbError);
  });

  it('rejects returning more stock than is on hand at the location', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 5 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id, { locationId: shelf.id }); // 5 on the shelf
    // Sell/consume 4 away so only 1 remains, then try to return all 5.
    await items.sell({ itemId: item.id, quantity: 4, unitSalePrice: 1, fromLocationId: shelf.id });
    await expect(pos.returnLine(line.id, { locationId: shelf.id })).rejects.toBeInstanceOf(DbError);
  });

  // --- on-order projection -------------------------------------------------------

  it('projects on-order quantity only for active (non-DRAFT/CANCELLED) orders', async () => {
    const item = await items.create({ name: 'IC' });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
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

  it('batch-reads on-order quantities for a set of items in one round-trip', async () => {
    const a = await items.create({ name: 'Item A' });
    const b = await items.create({ name: 'Item B' });
    const c = await items.create({ name: 'Item C' }); // no PO line → absent from the map
    const d = await items.create({ name: 'Item D' }); // only a DRAFT/CANCELLED line → 0

    // Item A: two active POs, one partly received → 10 + (7 − 3) = 14 outstanding.
    const poA1 = await pos.create({ supplier: { supplierName: 'RS' } });
    await pos.addLine(poA1.id, { itemId: a.id, orderedQty: 10 });
    await pos.setStatus(poA1.id, 'ORDERED');
    const poA2 = await pos.create({ supplier: { supplierName: 'Mouser' } });
    const lineA2 = await pos.addLine(poA2.id, { itemId: a.id, orderedQty: 7 });
    await pos.setStatus(poA2.id, 'ORDERED');
    await pos.receiveLine(lineA2.id, { quantity: 3 });

    // Item B: one active PO → 5 outstanding.
    const poB = await pos.create({ supplier: { supplierName: 'Farnell' } });
    await pos.addLine(poB.id, { itemId: b.id, orderedQty: 5 });
    await pos.setStatus(poB.id, 'ORDERED');

    // Item D: a line left DRAFT and another CANCELLED → contributes nothing.
    const poD1 = await pos.create({ supplier: { supplierName: 'RS' } });
    await pos.addLine(poD1.id, { itemId: d.id, orderedQty: 9 }); // stays DRAFT
    const poD2 = await pos.create({ supplier: { supplierName: 'RS' } });
    await pos.addLine(poD2.id, { itemId: d.id, orderedQty: 4 });
    await pos.setStatus(poD2.id, 'ORDERED');
    await pos.setStatus(poD2.id, 'CANCELLED');

    const map = await pos.onOrderQtyForItems([a.id, b.id, c.id, d.id]);
    expect(map.get(a.id)).toBe(14);
    expect(map.get(b.id)).toBe(5);
    // Items with no outstanding lines are simply absent (a caller reads that as 0).
    expect(map.has(c.id)).toBe(false);
    expect(map.has(d.id)).toBe(false);

    // The batch figure agrees with the scalar read for every item.
    for (const item of [a, b, c, d]) {
      expect(map.get(item.id) ?? 0).toBe(await pos.onOrderQtyForItem(item.id));
    }
  });

  it('returns an empty map for an empty item set (no query)', async () => {
    const map = await pos.onOrderQtyForItems([]);
    expect(map.size).toBe(0);
  });

  // --- FK SET NULL on the supplier-part link -------------------------------------

  it('NULLs a line supplier_part_id when the supplier part is deleted, keeping the line', async () => {
    const item = await items.create({ name: 'Resistor' });
    const sp = await supplierParts.create(item.id, {
      supplier: { supplierName: 'DigiKey' },
      orderCode: 'R-1',
    });
    const po = await pos.create({ supplier: { supplierName: 'DigiKey' } });
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
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 5 });
    await pos.delete(po.id);
    expect(await pos.getById(po.id)).toBeUndefined();
    expect(await pos.getLine(line.id)).toBeUndefined();
  });

  // --- supplier identity (issue #384) --------------------------------------------

  it('folds a re-typed supplier name onto the same supplier record', async () => {
    const a = await pos.create({ supplier: { supplierName: 'RS Components' } });
    const b = await pos.create({ supplier: { supplierName: 'rs-components' } });
    expect(b.supplierId).toBe(a.supplierId);
    expect(b.supplierName).toBe('RS Components'); // the first spelling is the stored one
  });

  it('re-points a purchase order at another supplier through update', async () => {
    const rs = await suppliers.create({ name: 'RS' });
    const mouser = await suppliers.create({ name: 'Mouser' });
    const po = await pos.create({ supplier: { supplierId: rs.id }, reference: 'PO-9' });

    const moved = await pos.update(po.id, { supplier: { supplierId: mouser.id } });
    expect(moved.supplierId).toBe(mouser.id);
    expect(moved.supplierName).toBe('Mouser');
    expect(moved.reference).toBe('PO-9'); // the order itself is untouched
  });

  it('keeps an order when its supplier is deleted, unlinking it (SET NULL)', async () => {
    const rs = await suppliers.create({ name: 'RS' });
    const po = await pos.create({ supplier: { supplierId: rs.id }, reference: 'PO-11' });

    // ON DELETE SET NULL — spend history is not dropped by tidying the supplier list; the
    // order survives and simply stops naming a supplier.
    await suppliers.delete(rs.id);

    const after = await pos.getById(po.id);
    expect(after?.reference).toBe('PO-11');
    expect(after?.supplierId).toBeNull();
    expect(after?.supplierName).toBeNull();
  });

  it('re-points an order at the target when its supplier is merged away', async () => {
    const rs = await suppliers.create({ name: 'RS' });
    const canonical = await suppliers.create({ name: 'RS Components' });
    const po = await pos.create({ supplier: { supplierId: rs.id } });

    // Merging is what a user wants for a *duplicate*: the order keeps naming a supplier.
    await suppliers.merge(rs.id, canonical.id);

    expect(await suppliers.getById(rs.id)).toBeUndefined();
    const after = await pos.getById(po.id);
    expect(after?.supplierId).toBe(canonical.id);
    expect(after?.supplierName).toBe('RS Components');
  });

  // --- Phase 65: createDraftFromReorderPlan --------------------------------------

  it('creates one DRAFT PO per named supplier group, skipping Unassigned', async () => {
    const res = await items.create({ name: 'Resistor', quantity: 2 });
    const cap = await items.create({ name: 'Capacitor', quantity: 1 });
    const led = await items.create({ name: 'LED', quantity: 0 });

    // The plan groups on supplier *identity*, so each named group carries a real supplier id.
    const digikey = await suppliers.create({ name: 'DigiKey' });
    const mouser = await suppliers.create({ name: 'Mouser' });

    const plan = [
      {
        supplierId: digikey.id,
        supplierName: 'DigiKey',
        supplierKey: digikey.id,
        lines: [
          {
            itemId: res.id,
            itemName: 'Resistor',
            supplierPartId: null,
            orderQty: 8,
            onOrder: 0,
            unitCost: 0.05,
          },
          {
            itemId: cap.id,
            itemName: 'Capacitor',
            supplierPartId: null,
            orderQty: 5,
            onOrder: 0,
            unitCost: 0.1,
          },
        ],
      },
      {
        supplierId: mouser.id,
        supplierName: 'Mouser',
        supplierKey: mouser.id,
        lines: [
          { itemId: led.id, itemName: 'LED', supplierPartId: null, orderQty: 10, onOrder: 0, unitCost: 0.2 },
        ],
      },
      {
        supplierId: null,
        supplierName: 'Unassigned',
        supplierKey: '~unassigned',
        lines: [
          {
            itemId: res.id,
            itemName: 'Another',
            supplierPartId: null,
            orderQty: 1,
            onOrder: 0,
            unitCost: null,
          },
        ],
      },
    ] as const;

    const created = await pos.createDraftFromReorderPlan(plan);

    // Two named supplier groups → two DRAFT POs; Unassigned is skipped.
    expect(created).toHaveLength(2);
    expect(created.map((p) => p.supplierName).sort()).toEqual(['DigiKey', 'Mouser']);
    // Each order points at the very supplier its group identified — no name re-resolution.
    expect(created.map((p) => p.supplierId).sort()).toEqual([digikey.id, mouser.id].sort());

    const dk = created.find((p) => p.supplierName === 'DigiKey')!;
    expect(dk.effectiveStatus).toBe('DRAFT');
    expect(dk.lines).toHaveLength(2);
    expect(dk.lines.find((l) => l.itemId === res.id)?.orderedQty).toBe(8);
    expect(dk.lines.find((l) => l.itemId === cap.id)?.orderedQty).toBe(5);

    const mu = created.find((p) => p.supplierName === 'Mouser')!;
    expect(mu.lines).toHaveLength(1);
    expect(mu.lines[0]!.orderedQty).toBe(10);
  });

  it('creates no POs when the plan is empty or only contains Unassigned', async () => {
    const result = await pos.createDraftFromReorderPlan([]);
    expect(result).toHaveLength(0);

    const result2 = await pos.createDraftFromReorderPlan([
      { supplierId: null, supplierName: 'Unassigned', supplierKey: '~unassigned', lines: [] },
    ]);
    expect(result2).toHaveLength(0);
  });

  // --- overlapping receipts & atomic status (issue #298) -------------------------

  it('rejects the loser of two overlapping receipts instead of double-counting stock', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 10 });
    await pos.setStatus(po.id, 'ORDERED');

    // Both receipts plan against the same received_qty of 0 — the stale read the issue describes.
    const first = pos.receiveLine(line.id, { locationId: shelf.id, quantity: 10 });
    const second = pos.receiveLine(line.id, { locationId: shelf.id, quantity: 10 });

    await first;
    await expect(second).rejects.toMatchObject({
      name: 'DbError',
      message: PO_RECEIPT_RACE_MESSAGE,
    });

    // The line and the ledger agree: 10 received on the order, 10 units on the shelf.
    expect((await pos.getLine(line.id))?.receivedQty).toBe(10);
    expect((await items.getById(item.id))?.quantity).toBe(10);
    const history = await items.getHistory(item.id);
    expect(history.rows.filter((h) => h.action === 'RECEIVED')).toHaveLength(1);
  });

  it('rejects a return that overlaps a receipt, leaving nothing half-applied', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 10 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id, { locationId: shelf.id, quantity: 6 });

    // The remaining receipt and a full return both plan against received_qty = 6; only one lands.
    const settled = await Promise.allSettled([
      pos.receiveLine(line.id, { locationId: shelf.id, quantity: 4 }),
      pos.returnLine(line.id, { locationId: shelf.id, quantity: 6 }),
    ]);

    // Whichever commits first, the other finds the line moved and aborts whole — asserted without
    // depending on which of the two the driver happens to run first.
    const rejections = settled.filter((r) => r.status === 'rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ reason: { message: PO_RECEIPT_RACE_MESSAGE } });

    // The invariant the issue is about: the order's received total equals the units on the shelf.
    const receivedQty = (await pos.getLine(line.id))!.receivedQty;
    expect([10, 0]).toContain(receivedQty);
    expect((await items.getById(item.id))?.quantity).toBe(receivedQty);
  });

  it('rolls the status snapshot back with the receipt that failed', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(po.id, 'ORDERED');

    const first = pos.receiveLine(line.id, { quantity: 2 });
    const second = pos.receiveLine(line.id, { quantity: 2 });
    await first;
    await expect(second).rejects.toThrow();

    // The winner's own snapshot landed in its transaction; the loser left no trace of its own.
    const after = await pos.getWithLines(po.id);
    expect(after?.status).toBe('PARTIAL');
    expect(after?.lines[0]!.receivedQty).toBe(2);
  });

  it('leaves a CANCELLED order CANCELLED when a line is received', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 3 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.setStatus(po.id, 'CANCELLED');

    await pos.receiveLine(line.id);

    // DRAFT / CANCELLED are user-authoritative; only the line's progress moves.
    const after = await pos.getWithLines(po.id);
    expect(after?.status).toBe('CANCELLED');
    expect(after?.effectiveStatus).toBe('CANCELLED');
    expect(after?.lines[0]!.receivedQty).toBe(3);
  });

  it('receiving an already-complete line is a no-op, not a race rejection', async () => {
    const item = await items.create({ name: 'IC', quantity: 0 });
    const po = await pos.create({ supplier: { supplierName: 'RS' } });
    const line = await pos.addLine(po.id, { itemId: item.id, orderedQty: 2 });
    await pos.setStatus(po.id, 'ORDERED');
    await pos.receiveLine(line.id);

    const again = await pos.receiveLine(line.id);
    expect(again.receivedQty).toBe(2);
    expect((await items.getById(item.id))?.quantity).toBe(2);
    expect((await pos.getById(po.id))?.status).toBe('RECEIVED');
  });

  describe('isReceivedQtyGuardViolation', () => {
    // The three drivers report this identical failure under different codes, so the predicate
    // keys on the message alone — see its doc comment.
    it.each(['SQLITE_CONSTRAINT', 'TRANSACTION_FAILED', 'UNKNOWN'] as const)(
      'recognises the guard CHECK reported under %s',
      (code) => {
        expect(
          isReceivedQtyGuardViolation(new DbError(code, 'CHECK constraint failed: received_qty >= 0')),
        ).toBe(true);
      },
    );

    it('leaves every other failure alone', () => {
      // The stock ledger's own floor must not be mistaken for the receipt guard.
      expect(
        isReceivedQtyGuardViolation(
          new DbError('SQLITE_CONSTRAINT', 'CHECK constraint failed: quantity >= 0'),
        ),
      ).toBe(false);
      expect(
        isReceivedQtyGuardViolation(
          new DbError('SQLITE_CONSTRAINT', 'CHECK constraint failed: ordered_qty > 0'),
        ),
      ).toBe(false);
      expect(isReceivedQtyGuardViolation(new Error('CHECK constraint failed: received_qty >= 0'))).toBe(
        false,
      );
      expect(isReceivedQtyGuardViolation(undefined)).toBe(false);
    });
  });

  it('stamps unit cost on the PO line from the plan', async () => {
    const item = await items.create({ name: 'Relay', quantity: 0 });
    const farnell = await suppliers.create({ name: 'Farnell' });
    const plan = [
      {
        supplierId: farnell.id,
        supplierName: 'Farnell',
        supplierKey: farnell.id,
        lines: [
          {
            itemId: item.id,
            itemName: 'Relay',
            supplierPartId: null,
            orderQty: 3,
            onOrder: 0,
            unitCost: 1.25,
          },
        ],
      },
    ] as const;
    const [po] = await pos.createDraftFromReorderPlan(plan);
    expect(po!.lines[0]!.unitCost).toBe(1.25);
  });
});
