/**
 * Drift test for the two definitions of "an open purchase order" (issue #573).
 *
 * A PO's effective status is derived from its lines' receipt totals rather than stored, so
 * `derivePoStatus` (TypeScript, over the lines of one order) and `OPEN_PURCHASE_ORDER_WHERE`
 * (SQL, over the whole table) both encode it. The SQL one exists because counting open orders in
 * JavaScript means first reading every order — the capped-page bug the count was added to fix —
 * and the TypeScript one exists because a screen shows each order's own status. Neither can be
 * derived from the other, so this drives **both** over the same orders and fails when they part
 * company. Mutate either side and it goes red.
 *
 * It deliberately does not compare the two definitions' source text: it builds an order in every
 * state the derivation distinguishes, asks the database for the open count, and asks
 * `derivePoStatus` (through `list`'s `effectiveStatus`) for the same verdict order by order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { PurchaseOrderRepository } from './PurchaseOrderRepository';

describe('purchase-order "open" count — SQL/derivePoStatus parity (issue #573)', () => {
  let driver: MemoryDriver;
  let pos: PurchaseOrderRepository;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    pos = new PurchaseOrderRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Every order the database holds, with the effective status `derivePoStatus` gives it. */
  async function everyOrder() {
    const rows: { id: string; effectiveStatus: string }[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await pos.list({ limit: 100, offset });
      rows.push(...page.rows.map((po) => ({ id: po.id, effectiveStatus: po.effectiveStatus })));
      if (page.rows.length < 100) break;
    }
    return rows;
  }

  /**
   * The open count as `derivePoStatus` would have it — the JavaScript side of the claim, read
   * over *every* order rather than a page, which is the whole point of the SQL side.
   */
  async function openCountByDerivation(): Promise<number> {
    const rows = await everyOrder();
    return rows.filter((po) => po.effectiveStatus !== 'RECEIVED' && po.effectiveStatus !== 'CANCELLED')
      .length;
  }

  it('agrees with derivePoStatus across every state an order can be in', async () => {
    const item = await items.create({ name: 'Widget', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });

    // DRAFT, nothing received.
    await pos.create({ supplier: { supplierName: 'Alpha Supplies' }, reference: 'draft-empty' });

    // DRAFT with a fully-received line — DRAFT is authoritative, so still open.
    const draftReceived = await pos.create({
      supplier: { supplierName: 'Alpha Supplies' },
      reference: 'draft-received',
    });
    const draftLine = await pos.addLine(draftReceived.id, { itemId: item.id, orderedQty: 2 });
    await pos.receiveLine(draftLine.id, { locationId: shelf.id });

    // ORDERED with nothing received.
    const ordered = await pos.create({ supplier: { supplierName: 'Beta Parts' }, reference: 'ordered' });
    await pos.addLine(ordered.id, { itemId: item.id, orderedQty: 5 });
    await pos.setStatus(ordered.id, 'ORDERED');

    // ORDERED with no lines at all — nothing to have received, so ORDERED and open.
    const orderedEmpty = await pos.create({
      supplier: { supplierName: 'Beta Parts' },
      reference: 'ordered-empty',
    });
    await pos.setStatus(orderedEmpty.id, 'ORDERED');

    // PARTIAL — some of one line received.
    const partial = await pos.create({ supplier: { supplierName: 'Gamma Ltd' }, reference: 'partial' });
    const partialLine = await pos.addLine(partial.id, { itemId: item.id, orderedQty: 5 });
    await pos.setStatus(partial.id, 'ORDERED');
    await pos.receiveLine(partialLine.id, { locationId: shelf.id, quantity: 2 });

    // PARTIAL across two lines — one complete, one untouched.
    const twoLines = await pos.create({ supplier: { supplierName: 'Gamma Ltd' }, reference: 'two-lines' });
    const doneLine = await pos.addLine(twoLines.id, { itemId: item.id, orderedQty: 3 });
    await pos.addLine(twoLines.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(twoLines.id, 'ORDERED');
    await pos.receiveLine(doneLine.id, { locationId: shelf.id });

    // RECEIVED — every line complete.
    const received = await pos.create({ supplier: { supplierName: 'Delta Co' }, reference: 'received' });
    const receivedLine = await pos.addLine(received.id, { itemId: item.id, orderedQty: 4 });
    await pos.setStatus(received.id, 'ORDERED');
    await pos.receiveLine(receivedLine.id, { locationId: shelf.id });

    // CANCELLED after a partial receipt — cancelled is authoritative, so not open.
    const cancelled = await pos.create({ supplier: { supplierName: 'Delta Co' }, reference: 'cancelled' });
    const cancelledLine = await pos.addLine(cancelled.id, { itemId: item.id, orderedQty: 6 });
    await pos.setStatus(cancelled.id, 'ORDERED');
    await pos.receiveLine(cancelledLine.id, { locationId: shelf.id, quantity: 1 });
    await pos.setStatus(cancelled.id, 'CANCELLED');

    const orders = await everyOrder();
    expect(orders).toHaveLength(8);
    // Both a spot-check of the derivation and the guard that the fixture really does cover
    // every branch — a parity assertion over one state proves nothing.
    expect(new Set(orders.map((o) => o.effectiveStatus))).toEqual(
      new Set(['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED']),
    );

    expect(await pos.count({ open: true })).toBe(await openCountByDerivation());
    expect(await pos.count({ open: true })).toBe(6);
    // The unfiltered count is unchanged by any of this — it is still every order.
    expect(await pos.count()).toBe(8);
  });

  it('agrees on an empty order book', async () => {
    expect(await pos.count({ open: true })).toBe(await openCountByDerivation());
    expect(await pos.count({ open: true })).toBe(0);
  });

  it('counts open orders that sit past the first page of the list', async () => {
    // The bug itself (issue #573): the list reads newest-first, so filling the first page with
    // received orders used to hide every open one behind it and the tile reported none.
    const item = await items.create({ name: 'Widget', quantity: 0 });
    const shelf = await locations.create({ name: 'Shelf A' });

    for (let i = 0; i < 5; i += 1) {
      const open = await pos.create({ supplier: { supplierName: 'Alpha Supplies' }, reference: `open-${i}` });
      await pos.addLine(open.id, { itemId: item.id, orderedQty: 2 });
      await pos.setStatus(open.id, 'ORDERED');
    }
    // Newer, and all fully received — these are what a single page would have shown.
    for (let i = 0; i < 105; i += 1) {
      const done = await pos.create({ supplier: { supplierName: 'Delta Co' }, reference: `done-${i}` });
      const line = await pos.addLine(done.id, { itemId: item.id, orderedQty: 1 });
      await pos.setStatus(done.id, 'ORDERED');
      await pos.receiveLine(line.id, { locationId: shelf.id });
    }

    const firstPage = await pos.list({ limit: 100, offset: 0 });
    expect(
      firstPage.rows.filter((po) => po.effectiveStatus !== 'RECEIVED' && po.effectiveStatus !== 'CANCELLED'),
    ).toHaveLength(0);
    expect(await pos.count({ open: true })).toBe(5);
    expect(await pos.count({ open: true })).toBe(await openCountByDerivation());
  });
});
