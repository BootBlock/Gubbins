import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';

describe('ItemRepository — Phase 9 (perishables, condition, variants, reconciliation)', () => {
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

  it('persists expiry/batch/lot/condition on create and exposes them on the item', async () => {
    const expiry = Date.now() + 30 * 86_400_000;
    const item = await items.create({
      name: 'Solder paste',
      expiryDate: expiry,
      batchNumber: 'B-42',
      lotNumber: 'L-7',
      condition: 'GOOD',
    });
    expect(item.expiryDate).toBe(Math.trunc(expiry));
    expect(item.batchNumber).toBe('B-42');
    expect(item.lotNumber).toBe('L-7');
    expect(item.condition).toBe('GOOD');
    expect(item.parentId).toBeNull();
  });

  it('logs CONDITION_CHANGED only when the condition actually changes', async () => {
    const item = await items.create({ name: 'Multimeter', condition: 'MINT' });
    await items.update(item.id, { condition: 'MINT' }); // no-op
    let history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'CONDITION_CHANGED')).toBe(false);

    const updated = await items.update(item.id, { condition: 'OUT_FOR_CALIBRATION' });
    expect(updated.condition).toBe('OUT_FOR_CALIBRATION');
    history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'CONDITION_CHANGED')).toBe(true);
  });

  it('rejects an unknown condition at the database level', async () => {
    await expect(
      items.create({ name: 'X', condition: 'SPARKLING' as never }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('lists perishables expiring within a window, soonest first, active only', async () => {
    const now = 1_700_000_000_000;
    await items.create({ name: 'Fresh', expiryDate: now + 90 * 86_400_000 });
    const soon = await items.create({ name: 'Soon', expiryDate: now + 10 * 86_400_000 });
    const expired = await items.create({ name: 'Expired', expiryDate: now - 86_400_000 });
    await items.create({ name: 'NonPerishable' });
    const inactive = await items.create({ name: 'Gone', expiryDate: now + 5 * 86_400_000 });
    await items.softDelete(inactive.id);

    const page = await items.listExpiringWithin(30, now);
    expect(page.rows.map((r) => r.name)).toEqual(['Expired', 'Soon']);
    expect(page.rows[0].id).toBe(expired.id);
    expect(page.rows[1].id).toBe(soon.id);
  });

  it('creates child variants under an abstract parent and lists them', async () => {
    const parent = await items.create({ name: 'Resistor 0805' });
    const a = await items.createVariant(parent.id, { name: '10k', quantity: 500 });
    const b = await items.createVariant(parent.id, { name: '1k', quantity: 200 });
    expect(a.parentId).toBe(parent.id);
    expect(b.parentId).toBe(parent.id);

    const variants = await items.listVariants(parent.id);
    expect(variants.rows.map((r) => r.name).sort()).toEqual(['10k', '1k']);

    const history = await items.getHistory(a.id);
    expect(history.rows.some((h) => h.action === 'VARIANT_CREATED')).toBe(true);
  });

  it('refuses to nest variants (single-level model) and self-parenting', async () => {
    const parent = await items.create({ name: 'Capacitor' });
    const variant = await items.createVariant(parent.id, { name: '100nF' });
    // Cannot create a variant under a variant.
    await expect(items.createVariant(variant.id, { name: 'X' })).rejects.toBeInstanceOf(DbError);
    // Cannot attach a parent (with variants) as someone else's variant.
    const other = await items.create({ name: 'Other' });
    await expect(items.setParent(parent.id, other.id)).rejects.toBeInstanceOf(DbError);
    // Cannot self-parent.
    await expect(items.setParent(other.id, other.id)).rejects.toBeInstanceOf(DbError);
  });

  it('attaches and detaches an existing item as a variant', async () => {
    const parent = await items.create({ name: 'LED' });
    const child = await items.create({ name: 'Red' });
    const attached = await items.setParent(child.id, parent.id);
    expect(attached.parentId).toBe(parent.id);
    const detached = await items.setParent(child.id, null);
    expect(detached.parentId).toBeNull();
  });

  it('reconciles a blind count: sets quantity and logs RECONCILED with the variance', async () => {
    const widget = await items.create({ name: 'Widget', quantity: 10 });
    const gadget = await items.create({ name: 'Gadget', quantity: 5 });
    const updated = await items.reconcile([
      { itemId: widget.id, counted: 8, note: 'Cycle count of Drawer A2: counted 8, expected 10 (adjustment -2).' },
      { itemId: gadget.id, counted: 5, note: 'unchanged' }, // zero variance → skipped
    ]);
    expect(updated).toHaveLength(1);
    expect(updated[0].quantity).toBe(8);

    const history = await items.getHistory(widget.id);
    const recon = history.rows.find((h) => h.action === 'RECONCILED');
    expect(recon?.quantityDelta).toBe(-2);
  });

  it('refuses to reconcile a non-discrete item or a negative count', async () => {
    const gauge = await items.create({
      name: 'Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });
    await expect(items.reconcile([{ itemId: gauge.id, counted: 5, note: 'x' }])).rejects.toBeInstanceOf(
      DbError,
    );
    const widget = await items.create({ name: 'Widget', quantity: 3 });
    await expect(items.reconcile([{ itemId: widget.id, counted: -1, note: 'x' }])).rejects.toBeInstanceOf(
      DbError,
    );
  });
});
