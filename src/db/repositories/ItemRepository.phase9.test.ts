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
    await expect(items.create({ name: 'X', condition: 'SPARKLING' as never })).rejects.toBeInstanceOf(
      DbError,
    );
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

  it('allows multi-level nesting (grandparent SKUs) — Phase 18', async () => {
    const grandparent = await items.create({ name: 'Capacitor' });
    const parent = await items.createVariant(grandparent.id, { name: 'Ceramic' });
    // A variant may itself hold sub-variants now (single-level rule lifted).
    const child = await items.createVariant(parent.id, { name: '100nF' });
    expect(child.parentId).toBe(parent.id);

    // A parent (with its own variants) may also be attached as someone else's variant.
    const other = await items.create({ name: 'Other' });
    const attached = await items.setParent(parent.id, other.id);
    expect(attached.parentId).toBe(other.id);
    // …and its existing sub-variant still hangs off it.
    expect((await items.listVariants(parent.id)).rows.map((r) => r.name)).toEqual(['100nF']);
  });

  it('still rejects cycles and self-parenting (§7.5.3, multi-level)', async () => {
    const a = await items.create({ name: 'A' });
    const b = await items.createVariant(a.id, { name: 'B' });
    const c = await items.createVariant(b.id, { name: 'C' });
    // Making A a variant of its own descendant C would form a cycle.
    await expect(items.setParent(a.id, c.id)).rejects.toBeInstanceOf(DbError);
    // Direct self-parenting is still refused.
    await expect(items.setParent(a.id, a.id)).rejects.toBeInstanceOf(DbError);
    // The hierarchy is unchanged after the rejected moves.
    expect((await items.getById(a.id))!.parentId).toBeNull();
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
      {
        itemId: widget.id,
        counted: 8,
        note: 'Cycle count of Drawer A2: counted 8, expected 10 (adjustment -2).',
      },
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

  it('serialised audit: soft-deletes a missing instance and logs RECONCILED -1', async () => {
    const [a, b, c] = await items.createSerialised({ name: 'Multimeter', count: 3 });
    const updated = await items.reconcileSerialised([
      { itemId: b.id, note: 'Serialised audit of Bench: Multimeter #2 not found — marked missing.' },
    ]);
    expect(updated).toHaveLength(1);
    expect(updated[0].isActive).toBe(false);

    // The flagged instance is gone from active inventory; the others remain.
    expect((await items.getById(b.id))!.isActive).toBe(false);
    expect((await items.getById(a.id))!.isActive).toBe(true);
    expect((await items.getById(c.id))!.isActive).toBe(true);

    const history = await items.getHistory(b.id);
    const recon = history.rows.find((h) => h.action === 'RECONCILED');
    expect(recon?.quantityDelta).toBe(-1);

    // Reversible — a found-again unit can be restored.
    expect((await items.restore(b.id)).isActive).toBe(true);
  });

  it('serialised audit: skips an already-inactive instance and rejects a non-serialised item', async () => {
    const [a] = await items.createSerialised({ name: 'Caliper', count: 1 });
    await items.softDelete(a.id);
    // Already removed → no-op, returns nothing, writes no second ledger entry.
    expect(await items.reconcileSerialised([{ itemId: a.id, note: 'x' }])).toHaveLength(0);

    const widget = await items.create({ name: 'Widget', quantity: 3 }); // DISCRETE
    await expect(items.reconcileSerialised([{ itemId: widget.id, note: 'x' }])).rejects.toBeInstanceOf(
      DbError,
    );
  });
});
