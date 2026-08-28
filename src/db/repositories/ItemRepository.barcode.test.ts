import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { BARCODE_MATCH_LIMIT } from './item/core';
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

  it('finds the active items carrying a barcode, case-insensitively', async () => {
    const item = await items.create({ name: 'Widget', barcode: 'ABC123' });
    expect((await items.findByBarcode('abc123')).map((i) => i.id)).toEqual([item.id]);
    expect(await items.findByBarcode('nope')).toEqual([]);
    expect(await items.findByBarcode('   ')).toEqual([]);
  });

  it('never returns a soft-deleted item, and returns every item sharing a barcode (issue #513)', async () => {
    const older = await items.create({ name: 'Older', barcode: '5000159407236' });
    await items.softDelete(older.id);
    // The deleted one is invisible even though it still holds the barcode.
    expect(await items.findByBarcode('5000159407236')).toEqual([]);

    const a = await items.create({ name: 'First', barcode: '111' });
    const b = await items.create({ name: 'Second', barcode: '111' });
    // Both are reported, so the scanner can ask which one was meant rather than adjusting
    // whichever happened to be created last.
    const hits = await items.findByBarcode('111');
    expect(hits.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('caps a shared barcode at BARCODE_MATCH_LIMIT, most recent first', async () => {
    const created: string[] = [];
    for (let n = 0; n < BARCODE_MATCH_LIMIT + 3; n += 1) {
      created.push((await items.create({ name: `Copy ${n}`, barcode: 'SHARED' })).id);
    }
    const hits = await items.findByBarcode('SHARED');
    expect(hits).toHaveLength(BARCODE_MATCH_LIMIT);
    // Every row is one of the items that carry the code, and the same call twice gives the same
    // rows — the cap slices a deterministic order, not an arbitrary one. (The rows are created
    // within one millisecond of each other, so which ones survive the cap is decided by the `id`
    // tiebreak rather than by `created_at`; asserting *which* would be asserting UUID order.)
    expect(hits.every((i) => created.includes(i.id))).toBe(true);
    expect((await items.findByBarcode('SHARED')).map((i) => i.id)).toEqual(hits.map((i) => i.id));
  });

  it('makes the barcode findable via full-text search', async () => {
    const item = await items.create({ name: 'Boxed thing', barcode: '9781234567897' });
    const page = await items.list({ search: '9781234567897' });
    expect(page.rows.map((r) => r.id)).toContain(item.id);
  });
});
