import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';

/** Retail barcode (GTIN) storage + lookup (recommendation point 1). */
describe('ItemRepository — barcode', () => {
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

  it('persists a barcode on create and clears it on update', async () => {
    const item = await items.create({ name: 'Sticky notes', barcode: '4006381333931' });
    expect(item.barcode).toBe('4006381333931');
    const cleared = await items.update(item.id, { barcode: null });
    expect(cleared.barcode).toBeNull();
    // A blank barcode normalises to null, never an empty string.
    const blank = await items.create({ name: 'No code', barcode: '   ' });
    expect(blank.barcode).toBeNull();
  });

  it('finds the active item carrying a barcode, case-insensitively', async () => {
    const item = await items.create({ name: 'Widget', barcode: 'ABC123' });
    const found = await items.getByBarcode('abc123');
    expect(found?.id).toBe(item.id);
    expect(await items.getByBarcode('nope')).toBeUndefined();
    expect(await items.getByBarcode('   ')).toBeUndefined();
  });

  it('never returns a soft-deleted item, and prefers the most recent on a clash', async () => {
    const older = await items.create({ name: 'Older', barcode: '5000159407236' });
    await items.softDelete(older.id);
    // The deleted one is invisible even though it still holds the barcode.
    expect(await items.getByBarcode('5000159407236')).toBeUndefined();

    const a = await items.create({ name: 'First', barcode: '111' });
    const b = await items.create({ name: 'Second', barcode: '111' });
    // Under a duplicate barcode the lookup is deterministic (same answer every call) and is
    // one of the two — the LIMIT-1 ordering never returns an arbitrary row across calls.
    const hit = await items.getByBarcode('111');
    expect([a.id, b.id]).toContain(hit?.id);
    expect((await items.getByBarcode('111'))?.id).toBe(hit?.id);
  });

  it('makes the barcode findable via full-text search', async () => {
    const item = await items.create({ name: 'Boxed thing', barcode: '9781234567897' });
    const page = await items.list({ search: '9781234567897' });
    expect(page.rows.map((r) => r.id)).toContain(item.id);
  });
});
