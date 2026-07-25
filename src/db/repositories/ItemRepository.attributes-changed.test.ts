/**
 * `ATTRIBUTES_CHANGED` — the item's field-edit audit trail (issue #144), which is also what
 * makes the notifiable edits webhook-able (`W10`).
 *
 * Before this, `ItemRepository.update` wrote a ledger row for only three of ~30 mutable fields,
 * so editing an item's price, barcode, category, reorder thresholds or expiry date recorded
 * nothing — and since the bridge derives events by diffing `item_history`, no ledger row means
 * no webhook could ever fire. These tests pin all three halves of the contract: every structured
 * field logs, the entry carries the **before and after values** (so the ledger answers "what was
 * it?" and not just "it changed"), and — the part most likely to create webhook noise — a write
 * that changes nothing does not.
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
    expect(entry!.metadata).toEqual({
      fields: ['unitCost'],
      // Money rides the ledger in major units — the scale the item DTO and every other
      // consumer speaks — not the stored micro-units the comparison happens in (issue #286).
      changes: [{ field: 'unitCost', from: 2.5, to: 3.75 }],
    });
    // A revaluation is not a realised stock movement, so it must not carry a value delta —
    // that column feeds the sales/margin report.
    expect(entry!.netValueDelta).toBeNull();
    expect(entry!.quantityDelta).toBeNull();
  });

  it.each([
    ['barcode', { barcode: '5012345678900' }, 'barcode', '5012345678900'],
    ['serialNumber', { serialNumber: 'SN-0042' }, 'serial number', 'SN-0042'],
    ['purchasePrice', { purchasePrice: 19.99 }, 'purchase price', 19.99],
    ['currentValue', { currentValue: 12 }, 'current value', 12],
    ['reorderPoint', { reorderPoint: 5 }, 'reorder point', 5],
    ['reorderGaugePercent', { reorderGaugePercent: 20 }, 'reorder gauge percentage', 20],
    ['reorderQty', { reorderQty: 10 }, 'reorder quantity', 10],
    ['expiryDate', { expiryDate: 1_800_000_000_000 }, 'expiry date', 1_800_000_000_000],
    // Issue #144 — the identity, provenance, lifecycle and measurement fields that used to
    // fall through to a bare UPDATE with no ledger row at all.
    ['mpn', { mpn: 'MPN-77' }, 'MPN', 'MPN-77'],
    ['manufacturer', { manufacturer: 'Example Works' }, 'manufacturer', 'Example Works'],
    ['batchNumber', { batchNumber: 'B-12' }, 'batch number', 'B-12'],
    ['lotNumber', { lotNumber: 'L-9' }, 'lot number', 'L-9'],
    ['acquiredAt', { acquiredAt: '2026-03-04' }, 'acquired date', '2026-03-04'],
    ['warrantyExpiresAt', { warrantyExpiresAt: '2028-03-04' }, 'warranty expiry', '2028-03-04'],
    ['depreciationMonths', { depreciationMonths: 36 }, 'depreciation period', 36],
    ['weight', { weight: 250 }, 'weight', 250],
    ['width', { width: 120 }, 'width', 120],
    ['height', { height: 45 }, 'height', 45],
    ['depth', { depth: 30 }, 'depth', 30],
  ])('logs a %s edit', async (field, patch, label, to) => {
    const item = await items.create({ name: 'Tracked field', quantity: 1 });

    await items.update(item.id, patch);

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe(`Changed ${label}.`);
    expect(entry?.metadata).toEqual({
      fields: [field],
      changes: [{ field, from: null, to }],
    });
  });

  it('logs a category change', async () => {
    await driver.execute("INSERT INTO categories (id, name) VALUES ('cat-1', 'Fasteners');");
    const item = await items.create({ name: 'Wood screw', quantity: 50 });

    await items.update(item.id, { categoryId: 'cat-1' });

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe('Changed category.');
    expect(entry?.metadata).toEqual({
      fields: ['categoryId'],
      changes: [{ field: 'categoryId', from: null, to: 'cat-1' }],
    });
  });

  it('records one entry listing every field an edit touched, not one per field', async () => {
    const item = await items.create({ name: 'Multi edit', quantity: 1, unitCost: 1 });

    await items.update(item.id, { unitCost: 2, barcode: '5012345678900', reorderPoint: 3 });

    const entries = await attributeEntries(item.id);
    expect(entries).toHaveLength(1);
    // Listed in the order `update` evaluates the fields, so the note and metadata always agree.
    expect(entries[0]!.note).toBe('Changed barcode, unit cost, reorder point.');
    expect(entries[0]!.metadata).toEqual({
      fields: ['barcode', 'unitCost', 'reorderPoint'],
      changes: [
        { field: 'barcode', from: null, to: '5012345678900' },
        { field: 'unitCost', from: 1, to: 2 },
        { field: 'reorderPoint', from: null, to: 3 },
      ],
    });
  });

  it('writes no entry when a tracked field is set to the value it already holds', async () => {
    const item = await items.create({
      name: 'Unchanged',
      quantity: 1,
      unitCost: 4.5,
      barcode: '5012345678900',
      reorderPoint: 2,
      mpn: 'MPN-77',
      weight: 250,
      acquiredAt: '2026-03-04',
    });

    await items.update(item.id, {
      unitCost: 4.5,
      barcode: '5012345678900',
      reorderPoint: 2,
      mpn: 'MPN-77',
      weight: 250,
      acquiredAt: '2026-03-04',
    });

    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('treats a blank string as no change to an already-null text field', async () => {
    // `normaliseText` collapses whitespace-only input to NULL, so this is a no-op write and
    // must not fire a webhook — comparison happens after normalisation for exactly this case.
    const item = await items.create({ name: 'Blank barcode', quantity: 1 });

    await items.update(item.id, { barcode: '   ', serialNumber: '', mpn: ' ', lotNumber: '' });

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
    expect(entry?.metadata).toEqual({
      fields: ['reorderPoint'],
      changes: [{ field: 'reorderPoint', from: 2, to: 7 }],
    });
  });

  it('leaves the free-prose and reporting-preference fields silent', async () => {
    // Recording a before/after copy of arbitrarily long prose on every edit would bloat a
    // ledger that syncs to every device; the toggles are reporting preferences, not facts
    // about the item.
    const item = await items.create({ name: 'Quiet fields', quantity: 1 });

    await items.update(item.id, {
      description: 'A new description',
      notes: 'Some notes',
      isFavourite: true,
      deadStockMode: 'never',
      operationalMetadata: { location: 'bench' },
    });

    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('clearing a tracked field back to null is a change, and records what was lost', async () => {
    const item = await items.create({ name: 'Cleared', quantity: 1, unitCost: 8, mpn: 'MPN-77' });

    await items.update(item.id, { unitCost: null, mpn: null });

    const [entry] = await attributeEntries(item.id);
    expect(entry?.note).toBe('Changed MPN, unit cost.');
    expect(entry?.metadata).toEqual({
      fields: ['mpn', 'unitCost'],
      changes: [
        { field: 'mpn', from: 'MPN-77', to: null },
        { field: 'unitCost', from: 8, to: null },
      ],
    });
  });

  it('records the old and new name in a rename entry, not only in its prose', async () => {
    const item = await items.create({ name: 'Old name', quantity: 1 });

    await items.update(item.id, { name: 'New name' });

    const history = await items.getHistory(item.id);
    const renamed = history.rows.find((h) => h.action === 'RENAMED');
    expect(renamed?.note).toBe('Renamed "Old name" → "New name".');
    expect(renamed?.metadata).toEqual({ from: 'Old name', to: 'New name' });
    // A rename has its own action, so it must not also be listed as a changed attribute.
    expect(await attributeEntries(item.id)).toHaveLength(0);
  });

  it('maps to the already-published item.changed event type, and reads sensibly in the feed', async () => {
    // The whole point of one generic action: no new dotted type, so no OpenAPI enum change.
    expect(ACTION_EVENT_TYPE.ATTRIBUTES_CHANGED).toBe('item.changed');
    expect(activityKindForAction('ATTRIBUTES_CHANGED')).toBe('lifecycle');
    expect(historyActionLabel('ATTRIBUTES_CHANGED')).toBe('Details changed');
  });
});
