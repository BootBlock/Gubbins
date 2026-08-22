/**
 * What a sync merge discarded, end-to-end across two devices (issue #487).
 *
 * The unit tests prove the reconcile engine *plans* the right record; this proves it lands, and
 * lands once, against real SQLite and the real merge path. That second half is what matters here:
 * `item_history` reconciles by union-of-id, so an entry minted with a fresh id would be appended
 * again by every replay of the same merge — the audit trail would grow a duplicate per sync
 * instead of recording one overwrite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYSTEM_USER_ID } from '@/db/repositories/constants';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { runSnapshotMerge, type SnapshotMergeRequest } from './merge';
import { buildLocalSnapshot } from './snapshot';

describe('a sync merge records what it overwrote (issue #487)', () => {
  let a: MemoryDriver;
  let b: MemoryDriver;
  let itemsA: ItemRepository;
  let itemsB: ItemRepository;

  beforeEach(async () => {
    a = createMemoryDriver();
    b = createMemoryDriver();
    await runMigrations(a, migrations);
    await runMigrations(b, migrations);
    itemsA = new ItemRepository(a);
    itemsB = new ItemRepository(b);
  });

  afterEach(async () => {
    await a.close();
    await b.close();
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
  async function sync(
    from: MemoryDriver,
    into: MemoryDriver,
    overrides: Partial<SnapshotMergeRequest> = {},
  ): Promise<void> {
    const remote = await buildLocalSnapshot(from);
    await runSnapshotMerge(into, request({ remote, ...overrides }));
  }

  /** One item's `MERGE_OVERWRITTEN` entries on `driver`, oldest first. */
  async function overwriteEntries(driver: MemoryDriver, itemId: string) {
    return driver.query<{ id: string; note: string; metadata: string; actor_user_id: string }>(
      `SELECT id, note, metadata, actor_user_id FROM item_history
        WHERE item_id = ? AND action = 'MERGE_OVERWRITTEN'
        ORDER BY created_at ASC, rowid ASC;`,
      [itemId],
    );
  }

  /**
   * Stamp an item's `updated_at` outright. `updated_at` is a wall-clock millisecond, so two
   * edits made in the same tick are a tie rather than a sequence; setting it explicitly is what
   * lets a test say which device's version is the newer one. A value that differs from the one
   * stored leaves the auto-stamp trigger dormant (`WHEN NEW.updated_at = OLD.updated_at`), so
   * this writes exactly what it says.
   */
  async function stamp(driver: MemoryDriver, itemId: string, at: number): Promise<void> {
    await driver.transaction([
      { sql: 'UPDATE items SET updated_at = ? WHERE id = ?;', params: [at, itemId] },
    ]);
  }

  /** The instant both devices were last in step; an edit after it is offline divergence. */
  const LAST_SYNC = 1_500;

  /**
   * Put both devices in step, then have each edit the same item offline. `b`'s version is the
   * newer one, so `a`'s edit is what last-write-wins discards when `b`'s state is merged into it.
   */
  async function divergeThenMerge(): Promise<string> {
    const item = await itemsA.create({ name: 'Cordless drill', unitCost: 40 });
    await sync(a, b);
    await stamp(a, item.id, 1_000);
    await stamp(b, item.id, 1_000);

    await itemsA.update(item.id, { name: 'Cordless drill (spare)', unitCost: 42 });
    await stamp(a, item.id, 2_000);
    await itemsB.update(item.id, { name: 'Drill, 18V', barcode: '5012345678900' });
    await stamp(b, item.id, 3_000);

    await sync(b, a, { conflictSince: LAST_SYNC });
    return item.id;
  }

  it('names every field it overwrote, and the value it discarded', async () => {
    const itemId = await divergeThenMerge();

    const entries = await overwriteEntries(a, itemId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.note).toBe(
      "A newer edit from another device overwrote this device's name, barcode, unit cost.",
    );
    expect(JSON.parse(entries[0]!.metadata)).toEqual({
      fields: ['name', 'barcode', 'unitCost'],
      changes: [
        { field: 'name', from: 'Cordless drill (spare)', to: 'Drill, 18V' },
        { field: 'barcode', from: null, to: '5012345678900' },
        // Money rides the ledger in major units, exactly as `ATTRIBUTES_CHANGED` records it.
        { field: 'unitCost', from: 42, to: 40 },
      ],
    });
    // No person asked for this write — the merge did it (issue #79, plan §2.4).
    expect(entries[0]!.actor_user_id).toBe(SYSTEM_USER_ID);
  });

  it('appends nothing on a re-merge of the same two versions', async () => {
    const itemId = await divergeThenMerge();
    const first = await overwriteEntries(a, itemId);

    // The same merge again — what a sync that applied but failed before its watermark advanced
    // replays on the next attempt.
    await sync(b, a, { conflictSince: LAST_SYNC });

    expect(await overwriteEntries(a, itemId)).toEqual(first);
  });

  it('travels to the peer as one entry, not as a second copy of the same overwrite', async () => {
    const itemId = await divergeThenMerge();
    await sync(a, b);
    await sync(b, a, { conflictSince: LAST_SYNC });

    const onA = await overwriteEntries(a, itemId);
    const onB = await overwriteEntries(b, itemId);
    expect(onA).toHaveLength(1);
    expect(onB.map((e) => e.id)).toEqual(onA.map((e) => e.id));
  });

  it('records nothing when this device simply receives an edit it never made', async () => {
    const item = await itemsA.create({ name: 'Bench vice' });
    await sync(a, b);
    await stamp(a, item.id, 1_000);
    await stamp(b, item.id, 1_000);

    await itemsB.update(item.id, { name: 'Bench vice, 100mm' });
    await stamp(b, item.id, 3_000);
    await sync(b, a, { conflictSince: LAST_SYNC });

    expect(await overwriteEntries(a, item.id)).toEqual([]);
    // The peer's own edit entry did arrive, so the change is not unrecorded — it is recorded
    // once, by the device that made it.
    const history = await itemsA.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RENAMED')).toBe(true);
  });

  it('records nothing on the device whose edit won', async () => {
    const itemId = await divergeThenMerge();
    await sync(a, b);

    expect(await overwriteEntries(b, itemId)).toHaveLength(1); // A's entry, synced across
    const authored = await b.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM item_history WHERE item_id = ? AND action = 'MERGE_OVERWRITTEN';`,
      [itemId],
    );
    expect(authored[0]!.n).toBe(1);
  });
});
