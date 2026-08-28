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

/** UPC-E canonicalisation on the write path (issue #508). */
describe('ItemRepository — UPC-E barcodes', () => {
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

  it('stores a UPC-E as the UPC-A it compresses, whichever form was written', async () => {
    // The eight digits an importer or a typist supplies, and the twelve a UPC-A scan of the same
    // article yields, are one barcode — so they must store as one value and find each other.
    const item = await items.create({ name: 'AA cells', barcode: '04252614' });
    expect(item.barcode).toBe('042100005264');
    expect((await items.findByBarcode('042100005264')).map((i) => i.id)).toEqual([item.id]);

    const updated = await items.update(item.id, { barcode: ' 14252611 ' });
    expect(updated.barcode).toBe('142100005261');
  });

  it('stores every other code exactly as given', async () => {
    // An EAN-8 that is not also a UPC-E, and a non-retail label, are untouched.
    expect((await items.create({ name: 'Small pack', barcode: '96385074' })).barcode).toBe('96385074');
    expect((await items.create({ name: 'Shelf', barcode: 'SHELF-A12' })).barcode).toBe('SHELF-A12');
    expect((await items.create({ name: 'Odd', barcode: '07350053' })).barcode).toBe('07350053');
  });
});

/** Items recorded before UPC-E codes were expanded (issue #508). */
describe('ItemRepository — barcodes recorded in the compressed form', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  /** Create an item, then force its barcode to the compressed form the old code stored. */
  const withStoredBarcode = async (name: string, barcode: string) => {
    const item = await items.create({ name });
    await driver.execute('UPDATE items SET barcode = ? WHERE id = ?;', [barcode, item.id]);
    return item.id;
  };

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('finds an item holding the eight printed digits when asked for the expanded code', async () => {
    // A scan of that pack now resolves to the UPC-A, and the item would be unreachable if the
    // lookup only ever asked for the one string it was given.
    const id = await withStoredBarcode('AA cells', '04252614');
    expect((await items.findByBarcode('042100005264')).map((i) => i.id)).toEqual([id]);
    // The printed form still finds it too — that is what a re-typed code would be.
    expect((await items.findByBarcode('04252614')).map((i) => i.id)).toEqual([id]);
  });

  it('leaves an untouched barcode alone when an unrelated field is saved', async () => {
    // The item editor sends its whole draft on every save, so a rename must not silently migrate
    // the barcode — that would rewrite a record nobody edited and log it as a change they made.
    const id = await withStoredBarcode('AA cells', '04252614');
    const renamed = await items.update(id, { name: 'AA batteries', barcode: '04252614' });
    expect(renamed.barcode).toBe('04252614');
    // Editing the field to a different value does canonicalise, as a fresh entry would.
    const edited = await items.update(id, { barcode: '14252611' });
    expect(edited.barcode).toBe('142100005261');
  });
});
