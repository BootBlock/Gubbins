import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';

/**
 * The cross-item global activity feed (Phase 80) — `ItemRepository.getHistoryFeed`. A
 * real `:memory:` SQL test over the immutable `item_history` ledger joined to `items`.
 */
describe('ItemRepository.getHistoryFeed (Phase 80 global activity feed)', () => {
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

  it('folds history across all items, newest-first, with the item name joined', async () => {
    const screws = await items.create({ name: 'M3 Screws', quantity: 10 });
    const printer = await items.create({ name: 'Ender 3', trackingMode: 'SERIALISED' });
    // A later event so the ordering is non-trivial.
    await items.update(screws.id, { name: 'M3 Cap Screws' });

    const feed = await items.getHistoryFeed();
    // 2 CREATED + 1 RENAMED.
    expect(feed.rows).toHaveLength(3);
    // Newest first: the rename is the most recent event.
    expect(feed.rows[0]?.action).toBe('RENAMED');
    expect(feed.rows[0]?.itemName).toBe('M3 Cap Screws');
    expect(feed.rows[0]?.itemIsActive).toBe(true);
    // Both items represented.
    const names = new Set(feed.rows.map((r) => r.itemName));
    expect(names).toContain('M3 Cap Screws');
    expect(names).toContain('Ender 3');
    void printer;
  });

  it('filters to the requested actions', async () => {
    const a = await items.create({ name: 'Part A' });
    await items.create({ name: 'Part B' });
    await items.update(a.id, { name: 'Part A v2' });

    const renames = await items.getHistoryFeed({ actions: ['RENAMED'] });
    expect(renames.rows).toHaveLength(1);
    expect(renames.rows[0]?.action).toBe('RENAMED');

    const both = await items.getHistoryFeed({ actions: ['RENAMED', 'CREATED'] });
    expect(both.rows).toHaveLength(3);
  });

  it('returns the full feed when actions is empty or omitted', async () => {
    await items.create({ name: 'Solo' });
    expect((await items.getHistoryFeed({ actions: [] })).rows).toHaveLength(1);
    expect((await items.getHistoryFeed()).rows).toHaveLength(1);
  });

  it('reflects the owning item active state', async () => {
    const gone = await items.create({ name: 'Doomed' });
    await items.softDelete(gone.id);
    const feed = await items.getHistoryFeed({ actions: ['CREATED'] });
    expect(feed.rows[0]?.itemIsActive).toBe(false);
  });

  it('paginates and clamps the limit', async () => {
    for (let i = 0; i < 5; i++) await items.create({ name: `Item ${i}` });
    const clamped = await items.getHistoryFeed({ limit: 1000 });
    expect(clamped.limit).toBe(100);
    expect(clamped.rows).toHaveLength(5);
    expect(clamped.hasMore).toBe(false);

    const firstTwo = await items.getHistoryFeed({ limit: 2 });
    expect(firstTwo.rows).toHaveLength(2);
    expect(firstTwo.hasMore).toBe(true);
    const next = await items.getHistoryFeed({ limit: 2, offset: 2 });
    expect(next.rows).toHaveLength(2);
    // No overlap between consecutive pages.
    const firstIds = new Set(firstTwo.rows.map((r) => r.id));
    expect(next.rows.some((r) => firstIds.has(r.id))).toBe(false);
  });

  it('is empty when nothing has happened', async () => {
    const feed = await items.getHistoryFeed();
    expect(feed.rows).toEqual([]);
    expect(feed.hasMore).toBe(false);
  });
});
