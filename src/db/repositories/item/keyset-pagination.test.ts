/**
 * Integration proof that keyset (seek) pagination returns the *exact same* rows in the *exact same
 * order* as the offset path, page for page, against a real in-memory database (issue #172).
 *
 * The dataset is deliberately adversarial for a seek predicate: favourites (the DESC lead key),
 * duplicate names and serialised clones (ties resolved only by the id tiebreak), and NULL sort
 * values (unit_cost / serial_no). If the seek predicate drifts from the ORDER BY by even one row,
 * the whole-sequence comparison fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '../ItemRepository';
import type { ItemListFilters, ItemSort } from '../ItemRepository';

describe('item keyset pagination', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);

    // A spread of names (some duplicated), favourites, serialised clones (shared name, serial_no
    // 1..n), and a mix of set / NULL unit_cost — every ordering edge in one set.
    await items.create({ name: 'Bolt', quantity: 10, unitCost: 5 });
    await items.create({ name: 'bolt', quantity: 3, unitCost: 5 }); // case tie with 'Bolt' under NOCASE
    await items.create({ name: 'Anchor', quantity: 7 }); // unit_cost NULL
    const fav = await items.create({ name: 'Zzz last-alphabetically', quantity: 1, unitCost: 99 });
    await items.update(fav.id, { isFavourite: true });
    await items.create({ name: 'Anchor', quantity: 7, unitCost: 12 }); // duplicate name
    await items.createSerialised({ name: 'Drill', count: 4 }); // 4 clones share the name 'Drill'
    await items.create({ name: 'Widget', quantity: 50 }); // unit_cost NULL
    await items.create({ name: 'Gadget', quantity: 2, unitCost: 100 });
    const fav2 = await items.create({ name: 'Aaa first-but-favourite', quantity: 4 });
    await items.update(fav2.id, { isFavourite: true });
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Page through the whole result set by keyset seek, returning the ids in visited order. */
  async function keysetIds(filters: ItemListFilters, pageSize: number): Promise<string[]> {
    const ids: string[] = [];
    let page = await items.list({ ...filters, limit: pageSize });
    ids.push(...page.rows.map((r) => r.id));
    let absolute = page.rows.length;
    while (page.hasMore && page.endCursor) {
      page = await items.list({
        ...filters,
        limit: pageSize,
        seek: { cursor: page.endCursor, direction: 'forward', startIndex: absolute },
      });
      ids.push(...page.rows.map((r) => r.id));
      absolute += page.rows.length;
    }
    return ids;
  }

  /** Page through the whole result set by classic offset, returning the ids in visited order. */
  async function offsetIds(filters: ItemListFilters, pageSize: number): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await items.list({ ...filters, limit: pageSize, offset });
      ids.push(...page.rows.map((r) => r.id));
      if (!page.hasMore) break;
    }
    return ids;
  }

  const SORTS: { label: string; sort?: readonly ItemSort[] }[] = [
    { label: 'default (favourites, name, serial_no, created_at)' },
    { label: 'name asc', sort: [{ field: 'name', direction: 'asc' }] },
    { label: 'name desc', sort: [{ field: 'name', direction: 'desc' }] },
    { label: 'quantity asc', sort: [{ field: 'quantity', direction: 'asc' }] },
    { label: 'unitCost asc (NULLs last)', sort: [{ field: 'unitCost', direction: 'asc' }] },
    { label: 'unitCost desc (NULLs last)', sort: [{ field: 'unitCost', direction: 'desc' }] },
    { label: 'createdAt desc', sort: [{ field: 'createdAt', direction: 'desc' }] },
  ];

  for (const { label, sort } of SORTS) {
    for (const pageSize of [1, 2, 3, 5]) {
      it(`keyset matches offset for ${label} at pageSize ${pageSize}`, async () => {
        const filters: ItemListFilters = sort ? { sort } : {};
        const viaOffset = await offsetIds(filters, pageSize);
        const viaKeyset = await keysetIds(filters, pageSize);
        // Same rows, same order — and the whole catalogue, not a truncated prefix.
        expect(viaKeyset).toEqual(viaOffset);
        expect(viaKeyset).toHaveLength(12); // 8 singletons + 4 serialised 'Drill' clones
      });
    }
  }

  it('echoes the running absolute index into Page.offset for a seek page', async () => {
    const p0 = await items.list({ limit: 5 });
    expect(p0.offset).toBe(0);
    const p1 = await items.list({
      limit: 5,
      seek: { cursor: p0.endCursor!, direction: 'forward', startIndex: 5 },
    });
    expect(p1.offset).toBe(5);
    expect(p1.hasMore).toBe(true);
  });

  it('a backward seek reconstructs the preceding page exactly, in forward order', async () => {
    const pageSize = 5;
    const p0 = await items.list({ limit: pageSize });
    const p1 = await items.list({
      limit: pageSize,
      seek: { cursor: p0.endCursor!, direction: 'forward', startIndex: pageSize },
    });
    // Seek *before* p1's first row → must return p0 exactly, forward-ordered, at offset 0.
    const back = await items.list({
      limit: pageSize,
      seek: { cursor: p1.startCursor!, direction: 'backward', startIndex: 0 },
    });
    expect(back.rows.map((r) => r.id)).toEqual(p0.rows.map((r) => r.id));
    expect(back.offset).toBe(0);
  });

  it('keyset respects a WHERE filter (favourites lead within the filtered set)', async () => {
    // Every item is active; add an inactive one to prove the seek predicate ANDs with the filter.
    const gone = await items.create({ name: 'Removed', quantity: 1 });
    await items.softDelete(gone.id);
    const viaOffset = await offsetIds({}, 3);
    const viaKeyset = await keysetIds({}, 3);
    expect(viaKeyset).toEqual(viaOffset);
    expect(viaKeyset).not.toContain(gone.id); // inactive filtered out on both paths
  });
});
