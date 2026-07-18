/**
 * `ATTRIBUTES_CHANGED` — the notifiable item-attribute edits (webhooks `W10`).
 *
 * Before this, `ItemRepository.update` wrote a ledger row for only three of ~30 mutable fields,
 * so editing an item's price, barcode, category, reorder thresholds or expiry date recorded
 * nothing — and since the bridge derives events by diffing `item_history`, no ledger row means
 * no webhook could ever fire. These tests pin both halves of the contract: the tracked fields do
 * log, and — the part most likely to create webhook noise — a write that changes nothing does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ACTION_EVENT_TYPE } from '@/features/events/event-types';
import { activityKindForAction } from '@/features/activity/activity-kind';
import { historyActionLabel } from '@/features/inventory/history-format';
import { ItemRepository } from './ItemRepository';

describe('ItemRepository — ATTRIBUTES_CHANGED ledger rows', () => {
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

  /** The `ATTRIBUTES_CHANGED` entries for an item, newest-first as the ledger returns them. */
  async function attributeEntries(itemId: string) {
    const history = await items.getHistory(itemId);
    return history.rows.filter((h) => h.action === 'ATTRIBUTES_CHANGED');
  }

  it('logs a price edit, naming the field in both the note and the metadata', async () => {
    const item = await items.create({ name: 'Brass hinge', quantity: 4, unitCost: 2.5 });

    await items.update(item.id, { unitCost: 3.75 });

    const [entry] = await attributeEntries(item.id);
    expect(entry).toBeDefined();
    expect(entry!.note).toBe('Changed unit cost.');
    expect(entry!.metadata).toEqual({ fields: ['unitCost'] });
    // A revaluation is not a realised stock movement, so it must not carry a value delta —
    // that column feeds the sales/margin report.
    expect(entry!.netValueDelta).toBeNull();
    expect(entry!.quantityDelta).toBeNull();
  });

  it.each([
    ['barcode', { barcode: '5012345678900' }, 'barcode'],
    ['serialNumber', { serialNumber: 'SN-0042' }, 'serial number'],
    ['purchasePrice', { purchasePrice: 19.99 }, 'purchase price'],
    ['currentValue', { currentValue: 12 }, 'current value'],
    ['reorderPoint', { reorderPoint: 5 }, 'reorder point'],
    ['reorderGaugePercent', { reorderGaugePercent: 20 }, 'reorder gauge percentage'],
    ['reorderQty', { reorderQty: 10 }, 'reorder quantity'],
    ['expiryDate', { expiryDate: 1_800_000_000_000 }, 'expiry date'],
  ])('logs a %s edit', async (field, patch, label) => {
    const item = await items.create({ name: 'Tracked field', quantity: 1 });

    await items.update(item.id, patch);

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe(`Changed ${label}.`);
    expect(entry?.metadata).toEqual({ fields: [field] });
  });

  it('logs a category change', async () => {
    await driver.execute("INSERT INTO categories (id, name) VALUES ('cat-1', 'Fasteners');");
    const item = await items.create({ name: 'Wood screw', quantity: 50 });

    await items.update(item.id, { categoryId: 'cat-1' });

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe('Changed category.');
    expect(entry?.metadata).toEqual({ fields: ['categoryId'] });
  });

  it('records one entry listing every field an edit touched, not one per field', async () => {
    const item = await items.create({ name: 'Multi edit', quantity: 1, unitCost: 1 });

    await items.update(item.id, { unitCost: 2, barcode: '5012345678900', reorderPoint: 3 });

    const entries = await attributeEntries(item.id);
    expect(entries).toHaveLength(1);
    // Listed in the order `update` evaluates the fields, so the note and metadata always agree.
    expect(entries[0]!.note).toBe('Changed barcode, unit cost, reorder point.');
    expect(entries[0]!.metadata).toEqual({ fields: ['barcode', 'unitCost', 'reorderPoint'] });
  });

  it('writes no entry when a tracked field is set to the value it already holds', async () => {
    const item = await items.create({
      name: 'Unchanged',
      quantity: 1,
      unitCost: 4.5,
      barcode: '5012345678900',
      reorderPoint: 2,
    });

    await items.update(item.id, { unitCost: 4.5, barcode: '5012345678900', reorderPoint: 2 });

    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('treats a blank string as no change to an already-null text field', async () => {
    // `normaliseText` collapses whitespace-only input to NULL, so this is a no-op write and
    // must not fire a webhook — comparison happens after normalisation for exactly this case.
    const item = await items.create({ name: 'Blank barcode', quantity: 1 });

    await items.update(item.id, { barcode: '   ', serialNumber: '' });

    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('treats a negative zero as unchanged against a stored zero', async () => {
    // `Number('-0')` is -0, which a re-import can hand back for an unchanged free item. An
    // `Object.is` comparison would call that a change and fire a webhook on every import.
    const item = await items.create({ name: 'Free sample', quantity: 1, unitCost: 0 });

    await items.update(item.id, { unitCost: -0 });

    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('logs only the fields that actually moved within a mixed edit', async () => {
    const item = await items.create({ name: 'Partial', quantity: 1, unitCost: 5, reorderPoint: 2 });

    await items.update(item.id, { unitCost: 5, reorderPoint: 7 });

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe('Changed reorder point.');
    expect(entry?.metadata).toEqual({ fields: ['reorderPoint'] });
  });

  it('leaves the deliberately history-free fields silent', async () => {
    const item = await items.create({ name: 'Quiet fields', quantity: 1 });

    await items.update(item.id, {
      description: 'A new description',
      notes: 'Some notes',
      isFavourite: true,
      deadStockMode: 'never',
    });

    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('clearing a tracked field back to null is a change', async () => {
    const item = await items.create({ name: 'Cleared', quantity: 1, unitCost: 8 });

    await items.update(item.id, { unitCost: null });

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe('Changed unit cost.');
  });

  it('maps to the already-published item.changed event type, and reads sensibly in the feed', async () => {
    // The whole point of one generic action: no new dotted type, so no OpenAPI enum change.
    expect(ACTION_EVENT_TYPE.ATTRIBUTES_CHANGED).toBe('item.changed');
    expect(activityKindForAction('ATTRIBUTES_CHANGED')).toBe('lifecycle');
    expect(historyActionLabel('ATTRIBUTES_CHANGED')).toBe('Details changed');
  });
});
