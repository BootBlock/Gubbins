/**
 * A resurrected row must not keep its tombstone, and a tombstone must not outrank the newer row
 * beside it (issue #537).
 *
 * The two halves combine into a convergence failure that no pair of devices can show. A row this
 * device deleted, that a peer then edited, comes back down as an ordinary upsert — but nothing
 * cleared the local tombstone, and `buildLocalSnapshot` reads that table wholesale, so the next
 * push carries the row *and* a record saying it is deleted. A third device that already adopted
 * the deletion then reads the tombstone, never compares it against the remote row standing beside
 * it, and skips the row for the whole 180-day TTL. Two devices hold the item; the third does not.
 *
 * So the tests here are deliberately three-device: the pair converges and hides it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { reconcile } from './reconcile';
import { runSnapshotMerge, type SnapshotMergeRequest } from './merge';
import { buildLocalSnapshot } from './snapshot';
import { runSync } from './sync-engine';
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncSnapshot, Tombstone } from './types';

const NO_QUOTA = { skipQuotaCheck: true } as const;

async function makeDevice(): Promise<{ driver: MemoryDriver; items: ItemRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  await driver.execute('PRAGMA foreign_keys = ON;');
  return { driver, items: new ItemRepository(driver) };
}

describe('a resurrected row and its tombstone (issue #537)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let c: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    c = await makeDevice();
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
    await c.driver.close();
  });

  function request(overrides: Partial<SnapshotMergeRequest> = {}): SnapshotMergeRequest {
    return {
      mode: 'delta',
      remote: null,
      offset: 0,
      effectiveNow: 1_000_000,
      lastSyncTimestamp: 0,
      historyPrunedBefore: 0,
      forceTies: false,
      ...overrides,
    };
  }

  /** Merge `from`'s current state into `into`, as a delta sync between two peers. */
  async function sync(from: MemoryDriver, into: MemoryDriver): Promise<void> {
    const remote = await buildLocalSnapshot(from);
    await runSnapshotMerge(into, request({ remote }));
  }

  /**
   * Stamp a row's `updated_at` outright. `updated_at` is a wall-clock millisecond, so two edits in
   * the same tick are a tie rather than a sequence; setting it explicitly is what lets a test say
   * which version is the newer one.
   */
  async function stamp(driver: MemoryDriver, table: string, id: string, at: number): Promise<void> {
    await driver.transaction([{ sql: `UPDATE ${table} SET updated_at = ? WHERE id = ?;`, params: [at, id] }]);
  }

  /** The same, for the instant a deletion was recorded. */
  async function stampTombstone(driver: MemoryDriver, table: string, id: string, at: number): Promise<void> {
    await driver.transaction([
      {
        sql: 'UPDATE tombstones SET deleted_at = ? WHERE table_name = ? AND id = ?;',
        params: [at, table, id],
      },
    ]);
  }

  async function holdsTombstone(driver: MemoryDriver, table: string, id: string): Promise<boolean> {
    const row = await driver.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM tombstones WHERE table_name = ? AND id = ?;',
      [table, id],
    );
    return Number(row?.n ?? 0) > 0;
  }

  async function holdsRow(driver: MemoryDriver, table: string, id: string): Promise<boolean> {
    const row = await driver.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?;`, [
      id,
    ]);
    return Number(row?.n ?? 0) > 0;
  }

  it('clears the tombstone for a row the merge brings back, and reaches the third device', async () => {
    const item = await a.items.create({ name: 'Impact driver' });
    await stamp(a.driver, 'items', item.id, 1_000);
    await sync(a.driver, b.driver);
    await sync(a.driver, c.driver);

    // A deletes it; C hears about the deletion and adopts the tombstone. B is offline throughout.
    await a.items.hardDelete(item.id);
    await stampTombstone(a.driver, 'items', item.id, 2_000);
    await sync(a.driver, c.driver);
    expect(await holdsRow(c.driver, 'items', item.id)).toBe(false);
    expect(await holdsTombstone(c.driver, 'items', item.id)).toBe(true);

    // B, which never saw the deletion, edits the item — strictly after A deleted it.
    await b.items.update(item.id, { name: 'Impact driver (18V)' });
    await stamp(b.driver, 'items', item.id, 3_000);

    // A pulls B: the newer row resurrects the id, so A's own tombstone for it must go.
    await sync(b.driver, a.driver);
    expect(await holdsRow(a.driver, 'items', item.id)).toBe(true);
    expect(await holdsTombstone(a.driver, 'items', item.id)).toBe(false);

    // C pulls A: it holds the deletion, and the row it is offered is newer than it.
    await sync(a.driver, c.driver);
    expect(await holdsRow(c.driver, 'items', item.id)).toBe(true);
    expect(await holdsTombstone(c.driver, 'items', item.id)).toBe(false);
  });

  it('re-creates a derived-id relation on every device, not just the pair (item_relations)', async () => {
    // `item_relations` keys a row by the canonical `from|to|kind` triple, so unlinking on one
    // device and re-linking on another produces a row and a tombstone under one id by
    // construction — no resurrection needed for the two records to travel together.
    const provider = new MemoryCloudProvider();
    const x = await a.items.create({ name: 'Amplifier' });
    const y = await a.items.create({ name: 'Speaker' });
    const rel = await a.items.addRelation({
      fromItemId: x.id,
      toItemId: y.id,
      kind: 'WORKS_WITH',
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(c.driver, provider, NO_QUOTA);
    expect(await holdsRow(c.driver, 'item_relations', rel.id)).toBe(true);

    // A unlinks the two; both peers adopt the removal.
    await a.items.removeRelation(rel.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(c.driver, provider, NO_QUOTA);
    expect(await holdsRow(c.driver, 'item_relations', rel.id)).toBe(false);

    // B links them again. Its snapshot now carries the row and the older tombstone side by side.
    await b.items.addRelation({ fromItemId: x.id, toItemId: y.id, kind: 'WORKS_WITH' });
    await stamp(b.driver, 'item_relations', rel.id, Date.now() + 60_000);
    expect(await holdsTombstone(b.driver, 'item_relations', rel.id)).toBe(true);
    await runSync(b.driver, provider, NO_QUOTA);

    await runSync(c.driver, provider, NO_QUOTA);
    expect(await holdsRow(c.driver, 'item_relations', rel.id)).toBe(true);
    expect(await c.items.listRelations(x.id)).toHaveLength(1);
  });
});

// --- the two rules, in isolation ------------------------------------------------------------

const DICTIONARY = { contacts: ['id', 'name', 'updated_at'] };

function snapshot(partial: { tables?: Record<string, SqlRow[]>; tombstones?: Tombstone[] }): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: partial.tables ?? {},
    tombstones: partial.tombstones ?? [],
    gaugeHistory: [],
    itemTags: [],
    locationTags: [],
    itemHistory: [],
  };
}

const opts = { offset: 0, dictionary: DICTIONARY };

describe('a remote tombstone versus the remote row beside it (issue #537)', () => {
  const row = { id: 'c1', name: 'Ada', updated_at: 200 };

  it('downloads a remote row strictly newer than the remote tombstone for the same id', () => {
    const local = snapshot({ tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 100 }] });
    const remote = snapshot({
      tables: { contacts: [row] },
      tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 100 }],
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.localUpserts).toEqual([{ table: 'contacts', row }]);
    expect(plan.localDeletes).toEqual([]);
  });

  it('still deletes when the remote tombstone is at least as new as the remote row', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Ada', updated_at: 150 }] } });
    const remote = snapshot({
      tables: { contacts: [row] },
      tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 200 }],
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.localUpserts).toEqual([]);
    expect(plan.localDeletes).toEqual([{ tableName: 'contacts', id: 'c1', deletedAt: 200 }]);
  });

  it('leaves our own newer deletion standing against the resurrected remote row', () => {
    const local = snapshot({ tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 300 }] });
    const remote = snapshot({
      tables: { contacts: [row] },
      tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 100 }],
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.localUpserts).toEqual([]);
    expect(plan.tombstoneClears).toEqual([]);
  });
});

describe('the tombstones a merge plan clears (issue #537)', () => {
  it('clears one for every id it resurrects, and nothing else', () => {
    const local = snapshot({
      tombstones: [
        { tableName: 'contacts', id: 'c1', deletedAt: 100 },
        { tableName: 'contacts', id: 'c2', deletedAt: 100 },
      ],
    });
    const remote = snapshot({
      tables: {
        contacts: [
          { id: 'c1', name: 'Ada', updated_at: 200 },
          { id: 'c3', name: 'Grace', updated_at: 200 },
        ],
      },
    });
    const plan = reconcile(local, remote, opts);
    // c1 is downloaded over our tombstone; c2 is untouched by this merge; c3 was never deleted.
    expect(plan.tombstoneClears).toEqual([{ tableName: 'contacts', id: 'c1' }]);
  });

  it('emits nothing when the device holds no tombstone for what it downloads', () => {
    const local = snapshot({});
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Ada', updated_at: 200 }] } });
    expect(reconcile(local, remote, opts).tombstoneClears).toEqual([]);
  });
});
