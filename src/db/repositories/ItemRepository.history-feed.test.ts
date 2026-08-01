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

  it('returns the full feed when actions is omitted', async () => {
    await items.create({ name: 'Solo' });
    expect((await items.getHistoryFeed()).rows).toHaveLength(1);
    expect((await items.getHistoryFeed({})).rows).toHaveLength(1);
  });

  it('matches nothing when actions is an explicit empty array (all kinds de-selected)', async () => {
    await items.create({ name: 'Solo' });
    const none = await items.getHistoryFeed({ actions: [] });
    expect(none.rows).toEqual([]);
    expect(none.hasMore).toBe(false);
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

/**
 * The feed's total-count companion (issue #20) — `countHistoryFeed` sizes the page count when
 * the Activity feed is shown paginated. It must mirror `getHistoryFeed`'s `WHERE` exactly so a
 * page count can never disagree with the pages it sizes.
 */
describe('ItemRepository.countHistoryFeed (issue #20 pagination)', () => {
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

  it('counts the whole feed when actions is omitted', async () => {
    const a = await items.create({ name: 'Part A' });
    await items.create({ name: 'Part B' });
    await items.update(a.id, { name: 'Part A v2' });
    // 2 CREATED + 1 RENAMED.
    expect(await items.countHistoryFeed()).toBe(3);
    expect(await items.countHistoryFeed({})).toBe(3);
  });

  it('counts only the requested actions, matching the feed', async () => {
    const a = await items.create({ name: 'Part A' });
    await items.create({ name: 'Part B' });
    await items.update(a.id, { name: 'Part A v2' });
    expect(await items.countHistoryFeed({ actions: ['RENAMED'] })).toBe(1);
    expect(await items.countHistoryFeed({ actions: ['CREATED'] })).toBe(2);

    // Agrees with the page it sizes.
    const feed = await items.getHistoryFeed({ actions: ['CREATED'] });
    expect(feed.rows).toHaveLength(await items.countHistoryFeed({ actions: ['CREATED'] }));
  });

  it('counts nothing for an explicit empty actions array (all kinds de-selected)', async () => {
    await items.create({ name: 'Solo' });
    expect(await items.countHistoryFeed({ actions: [] })).toBe(0);
  });

  it('is zero when nothing has happened', async () => {
    expect(await items.countHistoryFeed()).toBe(0);
  });

  // The count reads `item_history` alone while the feed joins `items` (issue #524). That is only
  // sound because the FK cascade means a purged item takes its ledger entries with it — so the
  // join it dropped could never have excluded a row. Pin the cascade, not just the arithmetic:
  // if it ever stopped firing, the count would over-report and size pages that do not exist.
  it('drops a purged item from the count and the feed alike (FK cascade, issue #524)', async () => {
    const doomed = await items.create({ name: 'Purge Me' });
    await items.create({ name: 'Keep Me' });
    await items.update(doomed.id, { name: 'Purge Me v2' });
    expect(await items.countHistoryFeed()).toBe(3);

    await items.hardDelete(doomed.id);

    // Both the CREATED and the RENAMED entry went with the item, leaving only 'Keep Me's
    // CREATED — so the unjoined count and the joined feed still agree, which is the invariant
    // the join removal rests on.
    expect(await items.countHistoryFeed()).toBe(1);
    const feed = await items.getHistoryFeed();
    expect(feed.rows).toHaveLength(1);
    expect(feed.rows[0]?.itemName).toBe('Keep Me');
  });
});

/**
 * The Activity Log's index (issue #524) — `idx_item_history_created_at`.
 *
 * These assert a **query plan**, not a result, because the plan is the entire point of the index:
 * every read below returns identical rows with or without it, and the only observable difference
 * is whether SQLite walks the index in order or sorts the whole ledger in a temp B-tree. A result
 * assertion cannot see that regress, so it would pass just as happily on the pathology this index
 * was added to remove.
 *
 * The plan is checked against the *real* migrated schema, so these fail if the index is dropped,
 * renamed, or given a shape (a `DESC` key, an `action` prefix) that no longer serves the order.
 *
 * What they deliberately do **not** pin is `getHistoryFeed` itself: {@link FEED_SQL} re-states its
 * query by hand, because the repository does not expose the SQL to import. So an ORDER BY edit in
 * `feeds.ts` will *not* fail these — it will only make the copy below stale. The two are kept in
 * step by the note on `getHistoryFeed`, not by the compiler; change one and change the other.
 */
describe('item_history cross-item reads seek idx_item_history_created_at (issue #524)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  const planOf = async (sql: string, params: readonly unknown[]): Promise<string> => {
    const rows = await driver.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [...params]);
    return rows.map((r) => r.detail).join(' | ');
  };

  // Mirrors `getHistoryFeed`'s SQL, including the `rowid DESC` tie-break — the part a `DESC` index
  // would fail to serve, leaving a per-tie-group `TEMP B-TREE FOR LAST TERM OF ORDER BY`.
  const FEED_SQL = `SELECT h.*, i.name AS item_name, i.is_active AS item_is_active
       FROM item_history h
       JOIN items i ON i.id = h.item_id
       {WHERE}
       ORDER BY h.created_at DESC, h.rowid DESC
       LIMIT ? OFFSET ?;`;

  it('orders the feed by walking the index, with no temp B-tree sort', async () => {
    const plan = await planOf(FEED_SQL.replace('{WHERE}', ''), [50, 0]);
    expect(plan).toContain('idx_item_history_created_at');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('keeps that ordered walk when the kind-filter chips narrow the feed', async () => {
    // The case a composite `(action, created_at)` index would regress: the planner would seek
    // `action` and then re-sort by `created_at`, reinstating the sort this index removes.
    const plan = await planOf(FEED_SQL.replace('{WHERE}', 'WHERE h.action IN (?, ?, ?)'), [
      'SOLD',
      'RENAMED',
      'MOVED',
      50,
      0,
    ]);
    expect(plan).toContain('idx_item_history_created_at');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('seeks the windowed reports’ created_at range instead of scanning the ledger', async () => {
    // The shape the three ledger-scanning windowed reports execute (`consumptionRate`,
    // `movement`, `salesAnalytics`): `created_at` bounded on both sides across all items.
    // `valuationTrend` writes the same range but is planned from `items` via
    // `idx_item_history_item_id`, so it is not represented here — see the note on the index.
    const plan = await planOf(
      `SELECT created_at, quantity_delta FROM item_history WHERE created_at >= ? AND created_at < ?;`,
      [0, 1],
    );
    expect(plan).toContain('SEARCH');
    expect(plan).toContain('idx_item_history_created_at');
  });

  it('seeks the history prune’s cutoff instead of scanning the ledger', async () => {
    const plan = await planOf(`SELECT COUNT(*) AS n FROM item_history WHERE created_at < ?;`, [0]);
    expect(plan).toContain('idx_item_history_created_at');
  });
});
