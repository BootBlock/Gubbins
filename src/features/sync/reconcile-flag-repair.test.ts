/**
 * Issues #157 / #192: `supplier_parts` carries two independent one-of-N flags per item —
 * `is_preferred` (valuation) and `is_price_source` (which supplier a price refresh fetches). Each
 * is maintained by an app-level demote-then-set, which per-row LWW cannot see across: two devices
 * that each pin a *different* supplier part offline converge to two rows sharing the flag. Left
 * alone that double-orders an item (#157) or refreshes the wrong supplier's cost (#192).
 *
 * The fix is a schema partial unique index (at most one flagged row per item) plus a repair before
 * every write. The pure tests assert the reconcile plan; the integration tests run the merge,
 * restore and clone paths over `node:sqlite` with the real migrations, because the claim that none
 * of them trips the index is about what the database actually does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { SYNC_TABLES, ITEM_HISTORY_TABLE } from '@/db/repositories/tombstone';
import { reconcile } from './reconcile';
import { applyPlan, buildCloneStatements, buildLocalSnapshot, restoreSnapshot } from './snapshot';
import { buildSchemaDictionary } from './schema-dictionary';
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncSnapshot, Tombstone } from './types';

// A dictionary carrying the supplier-part columns the tests set, so a downloaded row keeps them.
const DICTIONARY = {
  items: ['id', 'name', 'location_id', 'tracking_mode', 'updated_at'],
  suppliers: ['id', 'name', 'updated_at'],
  supplier_parts: ['id', 'item_id', 'supplier_id', 'is_preferred', 'is_price_source', 'updated_at'],
};

function snapshot(tables: Partial<Record<string, SqlRow[]>>, tombstones: Tombstone[] = []): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables,
    tombstones,
    gaugeHistory: [],
    itemTags: [],
    locationTags: [],
    itemHistory: [],
  };
}

/** A supplier-part row with the two flags defaulted off; override what a case needs. */
function part(over: Partial<SqlRow> & { id: string; item_id: string; updated_at: number }): SqlRow {
  return { supplier_id: 's1', is_preferred: 0, is_price_source: 0, ...over };
}

const opts = { offset: 0, dictionary: DICTIONARY };

describe('reconcile — one flag per item repair (§7.3, issues #157 / #192)', () => {
  it('demotes a stored loser when the remote pins a different supplier part', () => {
    // Local pinned p1 (stored, survives); the remote pinned p2 more recently → p2 is an upsert.
    const local = snapshot({
      supplier_parts: [
        part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 100 }),
        part({ id: 'p2', item_id: 'i1', updated_at: 50 }),
      ],
    });
    const remote = snapshot({
      supplier_parts: [part({ id: 'p2', item_id: 'i1', is_price_source: 1, updated_at: 200 })],
    });

    const plan = reconcile(local, remote, opts);

    // p1 is a stored loser → a demoting UPDATE (FlagRepair), not an upsert.
    expect(plan.flagRepairs).toEqual([
      { table: 'supplier_parts', itemId: 'i1', column: 'is_price_source', winnerId: 'p2' },
    ]);
    expect(plan.localUpserts.map((u) => u.row.id)).toEqual(['p2']);
    expect(plan.localUpserts[0]!.row.is_price_source).toBe(1);
  });

  it('zeroes a losing *upsert* in place with no demotion when no stored row holds the flag', () => {
    // Both rows arrive newer from the remote (fresh pins), so both are upserts; the older loses.
    const local = snapshot({
      supplier_parts: [
        part({ id: 'p1', item_id: 'i1', updated_at: 10 }),
        part({ id: 'p2', item_id: 'i1', updated_at: 10 }),
      ],
    });
    const remote = snapshot({
      supplier_parts: [
        part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 300 }),
        part({ id: 'p2', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
      ],
    });

    const plan = reconcile(local, remote, opts);

    // No stored row was flagged, so no DB demotion is needed — the loser's own upsert is zeroed.
    expect(plan.flagRepairs).toHaveLength(0);
    const byId = new Map(plan.localUpserts.map((u) => [u.row.id, u.row]));
    expect(byId.get('p1')!.is_price_source).toBe(1);
    expect(byId.get('p2')!.is_price_source).toBe(0);
  });

  it('breaks an exact updated_at tie by the smaller id, so both devices agree on the winner', () => {
    const local = snapshot({
      supplier_parts: [
        part({ id: 'p-a', item_id: 'i1', updated_at: 10 }),
        part({ id: 'p-b', item_id: 'i1', updated_at: 10 }),
      ],
    });
    const remote = snapshot({
      supplier_parts: [
        part({ id: 'p-b', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
        part({ id: 'p-a', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
      ],
    });

    const byId = new Map(reconcile(local, remote, opts).localUpserts.map((u) => [u.row.id, u.row]));
    expect(byId.get('p-a')!.is_price_source).toBe(1); // smaller id keeps the flag
    expect(byId.get('p-b')!.is_price_source).toBe(0);
  });

  it('demotes a previously-pinned part that is being deleted in the same merge (re-pin + delete)', () => {
    // The regression the schema index would otherwise re-introduce: the old pin `p2` still holds
    // the flag when the winner's upsert runs (its DELETE is ordered later), so it must be demoted
    // even though only one flagged row *survives*.
    const local = snapshot({
      supplier_parts: [
        part({ id: 'p2', item_id: 'i1', is_price_source: 1, updated_at: 50 }),
        part({ id: 'p1', item_id: 'i1', updated_at: 40 }),
      ],
    });
    const remote = snapshot(
      { supplier_parts: [part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 200 })] },
      [{ tableName: 'supplier_parts', id: 'p2', deletedAt: 200 }],
    );

    const plan = reconcile(local, remote, opts);

    expect(plan.localDeletes.map((d) => d.id)).toContain('p2');
    expect(plan.flagRepairs).toEqual([
      { table: 'supplier_parts', itemId: 'i1', column: 'is_price_source', winnerId: 'p1' },
    ]);
  });

  it('repairs the two flags independently against two stored losers', () => {
    // p1 (stored) held both flags; the remote pins a different part for each. Each stored loser
    // gets its own demotion.
    const local = snapshot({
      supplier_parts: [
        part({ id: 'p1', item_id: 'i1', is_preferred: 1, is_price_source: 1, updated_at: 100 }),
      ],
    });
    const remote = snapshot({
      supplier_parts: [
        part({ id: 'p2', item_id: 'i1', is_preferred: 1, updated_at: 200 }),
        part({ id: 'p3', item_id: 'i1', is_price_source: 1, updated_at: 300 }),
      ],
    });

    const plan = reconcile(local, remote, opts);

    const repairs = new Map(plan.flagRepairs.map((r) => [r.column, r.winnerId]));
    expect(repairs.get('is_preferred')).toBe('p2');
    expect(repairs.get('is_price_source')).toBe('p3');
    expect(plan.flagRepairs).toHaveLength(2);
  });

  it('leaves a single flagged row untouched', () => {
    const local = snapshot({ supplier_parts: [part({ id: 'p1', item_id: 'i1', updated_at: 5 })] });
    const remote = snapshot({
      supplier_parts: [part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 9 })],
    });
    expect(reconcile(local, remote, opts).flagRepairs).toHaveLength(0);
  });

  it('does not repair flags on parts of an item the merge is deleting', () => {
    const local = snapshot({
      items: [{ id: 'i1', name: 'Widget', location_id: UNASSIGNED_LOCATION_ID, updated_at: 1 }],
      supplier_parts: [
        part({ id: 'p1', item_id: 'i1', is_price_source: 1, updated_at: 100 }),
        part({ id: 'p2', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
      ],
    });
    const remote = snapshot({}, [{ tableName: 'items', id: 'i1', deletedAt: 500 }]);
    expect(reconcile(local, remote, opts).flagRepairs).toHaveLength(0);
  });
});

describe('supplier-part flag invariant over node:sqlite (issues #157 / #192)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    await driver.execute('INSERT INTO items (id, name, location_id, updated_at) VALUES (?, ?, ?, ?);', [
      'i1',
      'Widget',
      UNASSIGNED_LOCATION_ID,
      1,
    ]);
    await driver.execute('INSERT INTO suppliers (id, name, name_key, updated_at) VALUES (?, ?, ?, ?);', [
      's1',
      'Acme',
      'acme',
      1,
    ]);
    await driver.execute('INSERT INTO suppliers (id, name, name_key, updated_at) VALUES (?, ?, ?, ?);', [
      's2',
      'Globex',
      'globex',
      1,
    ]);
  });

  afterEach(async () => {
    await driver.close();
  });

  async function insertPart(
    id: string,
    flags: { pref?: number; price?: number },
    updatedAt = 1,
  ): Promise<void> {
    await driver.execute(
      `INSERT INTO supplier_parts (id, item_id, supplier_id, is_preferred, is_price_source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, 'i1', id === 'p2' ? 's2' : 's1', flags.pref ?? 0, flags.price ?? 0, updatedAt],
    );
  }

  async function pinnedPriceSource(): Promise<string[]> {
    const rows = await driver.query<{ id: string; is_price_source: number }>(
      'SELECT id, is_price_source FROM supplier_parts WHERE item_id = ? ORDER BY id;',
      ['i1'],
    );
    return rows.filter((r) => Number(r.is_price_source) === 1).map((r) => r.id);
  }

  it('the partial unique index forbids a second pinned price source for one item', async () => {
    await insertPart('p1', { price: 1 });
    await expect(insertPart('p2', { price: 1 })).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('the partial unique index forbids a second preferred supplier part for one item', async () => {
    await insertPart('p1', { pref: 1 });
    await expect(insertPart('p2', { pref: 1 })).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('the merge converges two pinned rows to one without tripping the index', async () => {
    // This device pinned p1; a peer pinned p2 more recently. Seed local, craft the peer's push.
    await insertPart('p1', { price: 1 }, 100);
    await insertPart('p2', { price: 0 }, 50);

    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const local = await buildLocalSnapshot(driver, 1);
    const remoteParts = (local.tables.supplier_parts ?? []).map((row) =>
      String(row.id) === 'p2' ? { ...row, is_price_source: 1, updated_at: 200 } : row,
    );
    const remote: SyncSnapshot = { ...local, tables: { ...local.tables, supplier_parts: remoteParts } };

    await applyPlan(driver, reconcile(local, remote, { offset: 0, dictionary }), dictionary);

    expect(await pinnedPriceSource()).toEqual(['p2']); // exactly one, the newer pin
  });

  it('a re-pin that also deletes the old pinned part does not trip the index (regression)', async () => {
    // Local pins p1; a peer re-pinned p2 and deleted p1. The delete applies after the upserts, so
    // p1 still holds the flag when p2's write lands — the merge must demote it first.
    await insertPart('p1', { price: 1 }, 100);
    await insertPart('p2', { price: 0 }, 50);

    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const local = await buildLocalSnapshot(driver, 1);
    const remote: SyncSnapshot = {
      ...local,
      tables: {
        ...local.tables,
        supplier_parts: [
          {
            ...(local.tables.supplier_parts ?? []).find((r) => r.id === 'p2')!,
            is_price_source: 1,
            updated_at: 200,
          },
        ],
      },
      tombstones: [{ tableName: 'supplier_parts', id: 'p1', deletedAt: 200 }],
    };

    await applyPlan(driver, reconcile(local, remote, { offset: 0, dictionary }), dictionary);

    expect(await pinnedPriceSource()).toEqual(['p2']); // p1 deleted, p2 the sole pin — no abort
  });

  it('restores a backup that carries two rows sharing a flag, keeping the newer', async () => {
    // A backup taken on a build that hit the bug carries two is_price_source=1 rows for one item.
    await insertPart('p1', { price: 0 }, 1); // seed the parts so the backup can overwrite them
    await insertPart('p2', { price: 0 }, 1);
    const snap = await buildLocalSnapshot(driver, 1);
    const corrupt: SyncSnapshot = {
      ...snap,
      tables: {
        ...snap.tables,
        supplier_parts: [
          { ...snap.tables.supplier_parts!.find((r) => r.id === 'p1')!, is_price_source: 1, updated_at: 100 },
          { ...snap.tables.supplier_parts!.find((r) => r.id === 'p2')!, is_price_source: 1, updated_at: 200 },
        ],
      },
    };

    // Without the dedupe the second row's INSERT would trip the index and abort the whole restore.
    await restoreSnapshot(driver, corrupt);
    expect(await pinnedPriceSource()).toEqual(['p2']);
  });

  it('restores a backup that pins a different part than the local one, adopting the backup pin', async () => {
    await insertPart('p1', { price: 1 }, 100); // local pins p1
    await insertPart('p2', { price: 0 }, 50);
    // A clean backup that pins p2 instead — restore must clear p1 before writing p2.
    const snap = await buildLocalSnapshot(driver, 1);
    const backup: SyncSnapshot = {
      ...snap,
      tables: {
        ...snap.tables,
        supplier_parts: [
          { ...snap.tables.supplier_parts!.find((r) => r.id === 'p1')!, is_price_source: 0 },
          { ...snap.tables.supplier_parts!.find((r) => r.id === 'p2')!, is_price_source: 1, updated_at: 200 },
        ],
      },
    };

    await restoreSnapshot(driver, backup);
    expect(await pinnedPriceSource()).toEqual(['p2']);
  });

  it('clones a remote with two flagged rows without silently dropping one (INSERT OR REPLACE)', async () => {
    await insertPart('p1', { price: 0 }, 1);
    await insertPart('p2', { price: 0 }, 1);
    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const snap = await buildLocalSnapshot(driver, 1);
    const remote: SyncSnapshot = {
      ...snap,
      tables: {
        ...snap.tables,
        supplier_parts: [
          { ...snap.tables.supplier_parts!.find((r) => r.id === 'p1')!, is_price_source: 1, updated_at: 100 },
          { ...snap.tables.supplier_parts!.find((r) => r.id === 'p2')!, is_price_source: 1, updated_at: 200 },
        ],
      },
    };

    await driver.transaction(buildCloneStatements(remote, dictionary));

    // Both rows survive (REPLACE would have deleted one); exactly one keeps the flag.
    const all = await driver.query<{ id: string }>('SELECT id FROM supplier_parts ORDER BY id;');
    expect(all.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(await pinnedPriceSource()).toEqual(['p2']);
  });
});
