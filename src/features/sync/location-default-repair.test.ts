/**
 * Issue #191: `locations.is_default` marks the single place "Add item" pre-selects, maintained by
 * an app-level demote-then-set. Per-row LWW cannot see that demotion across a merge: two devices
 * that each nominate a *different* default while offline converge to two rows both flagged. Left
 * alone that shows the "Default" badge on two locations and lets the pre-selected home fall to an
 * alphabetical tiebreak — neither user's intent.
 *
 * The fix is a schema partial unique index (at most one `is_default` row globally) plus a repair
 * before every write. The pure tests assert the reconcile plan; the integration tests run the
 * merge, restore and clone paths over `node:sqlite` with the real migrations, because the claim
 * that none of them trips the index is about what the database actually does.
 *
 * The structural twin of `reconcile-flag-repair.test.ts` (issues #157 / #192), which covers the
 * per-item `supplier_parts` flags; this one covers the *global* `is_default`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, ITEM_HISTORY_TABLE } from '@/db/repositories/tombstone';
import { reconcile } from './reconcile';
import { applyPlan, buildCloneStatements, buildLocalSnapshot, restoreSnapshot } from './snapshot';
import { buildSchemaDictionary } from './schema-dictionary';
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncSnapshot, Tombstone } from './types';

// A dictionary carrying the location columns the tests set, so a downloaded row keeps them.
const DICTIONARY = {
  locations: ['id', 'name', 'parent_id', 'is_system', 'is_default', 'updated_at'],
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

/** A location row with the default flag off; override what a case needs. */
function loc(over: Partial<SqlRow> & { id: string; updated_at: number }): SqlRow {
  return { name: over.id, parent_id: null, is_system: 0, is_default: 0, ...over };
}

const opts = { offset: 0, dictionary: DICTIONARY };

describe('reconcile — at most one default location (§7.3, issue #191)', () => {
  it('demotes a stored loser when the remote nominates a different default', () => {
    // Local made l1 the default (stored, survives); the remote made l2 the default more recently.
    const local = snapshot({
      locations: [loc({ id: 'l1', is_default: 1, updated_at: 100 }), loc({ id: 'l2', updated_at: 50 })],
    });
    const remote = snapshot({ locations: [loc({ id: 'l2', is_default: 1, updated_at: 200 })] });

    const plan = reconcile(local, remote, opts);

    // l1 is a stored loser → a demoting UPDATE keyed on the winner, not an upsert.
    expect(plan.defaultLocationWinnerId).toBe('l2');
    expect(plan.localUpserts.map((u) => u.row.id)).toEqual(['l2']);
    expect(plan.localUpserts[0]!.row.is_default).toBe(1);
  });

  it('zeroes a losing *upsert* in place with no demotion when no stored row holds the flag', () => {
    // Both rows arrive newer from the remote (fresh nominations), so both are upserts; the older loses.
    const local = snapshot({
      locations: [loc({ id: 'l1', updated_at: 10 }), loc({ id: 'l2', updated_at: 10 })],
    });
    const remote = snapshot({
      locations: [
        loc({ id: 'l1', is_default: 1, updated_at: 300 }),
        loc({ id: 'l2', is_default: 1, updated_at: 200 }),
      ],
    });

    const plan = reconcile(local, remote, opts);

    // No stored row was flagged, so no DB demotion is needed — the loser's own upsert is zeroed.
    expect(plan.defaultLocationWinnerId).toBeNull();
    const byId = new Map(plan.localUpserts.map((u) => [u.row.id, u.row]));
    expect(byId.get('l1')!.is_default).toBe(1); // newest wins
    expect(byId.get('l2')!.is_default).toBe(0);
  });

  it('breaks an exact updated_at tie by the smaller id, so both devices agree on the winner', () => {
    const local = snapshot({
      locations: [loc({ id: 'l-a', updated_at: 10 }), loc({ id: 'l-b', updated_at: 10 })],
    });
    const remote = snapshot({
      locations: [
        loc({ id: 'l-b', is_default: 1, updated_at: 200 }),
        loc({ id: 'l-a', is_default: 1, updated_at: 200 }),
      ],
    });

    const byId = new Map(reconcile(local, remote, opts).localUpserts.map((u) => [u.row.id, u.row]));
    expect(byId.get('l-a')!.is_default).toBe(1); // smaller id keeps the flag
    expect(byId.get('l-b')!.is_default).toBe(0);
  });

  it('demotes a previously-default location that is being deleted in the same merge', () => {
    // The regression the schema index would otherwise re-introduce: the old default `l2` still
    // holds the flag when the winner's upsert runs (its DELETE is ordered later), so it must be
    // demoted even though only one flagged row *survives*.
    const local = snapshot({
      locations: [loc({ id: 'l2', is_default: 1, updated_at: 50 }), loc({ id: 'l1', updated_at: 40 })],
    });
    const remote = snapshot({ locations: [loc({ id: 'l1', is_default: 1, updated_at: 200 })] }, [
      { tableName: 'locations', id: 'l2', deletedAt: 200 },
    ]);

    const plan = reconcile(local, remote, opts);

    expect(plan.defaultLocationWinnerId).toBe('l1'); // demote the to-be-deleted l2 before l1's write
    expect(plan.localUpserts.map((u) => u.row.id)).toEqual(['l1']);
  });

  it('needs no repair when the default is unchanged on both sides', () => {
    const local = snapshot({ locations: [loc({ id: 'l1', is_default: 1, updated_at: 100 })] });
    const remote = snapshot({ locations: [loc({ id: 'l1', is_default: 1, updated_at: 100 })] });
    expect(reconcile(local, remote, opts).defaultLocationWinnerId).toBeNull();
  });
});

describe('the locations default invariant over node:sqlite (issue #191)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  async function insertLocation(id: string, isDefault: number, updatedAt = 1): Promise<void> {
    await driver.execute('INSERT INTO locations (id, name, is_default, updated_at) VALUES (?, ?, ?, ?);', [
      id,
      id,
      isDefault,
      updatedAt,
    ]);
  }

  /** The ids currently marked default, ordered — the invariant says this is length ≤ 1. */
  async function defaults(): Promise<string[]> {
    const rows = await driver.query<{ id: string }>(
      'SELECT id FROM locations WHERE is_default = 1 ORDER BY id;',
    );
    return rows.map((r) => r.id);
  }

  it('the partial unique index forbids a second default location', async () => {
    await insertLocation('l1', 1);
    await expect(insertLocation('l2', 1)).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('the merge converges two nominated defaults to one without tripping the index', async () => {
    // This device made l1 the default; a peer made l2 the default more recently.
    await insertLocation('l1', 1, 100);
    await insertLocation('l2', 0, 50);

    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const local = await buildLocalSnapshot(driver, 1);
    const remoteLocations = (local.tables.locations ?? []).map((row) =>
      String(row.id) === 'l2' ? { ...row, is_default: 1, updated_at: 200 } : row,
    );
    const remote: SyncSnapshot = { ...local, tables: { ...local.tables, locations: remoteLocations } };

    await applyPlan(driver, reconcile(local, remote, { offset: 0, dictionary }), dictionary);

    expect(await defaults()).toEqual(['l2']); // exactly one, the newer nomination
  });

  it('a re-nomination that also deletes the old default does not trip the index (regression)', async () => {
    // Local made l1 the default; a peer made l2 the default and deleted l1. The delete applies
    // after the upserts, so l1 still holds the flag when l2's write lands — demote it first.
    await insertLocation('l1', 1, 100);
    await insertLocation('l2', 0, 50);

    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const local = await buildLocalSnapshot(driver, 1);
    const remote: SyncSnapshot = {
      ...local,
      tables: {
        ...local.tables,
        locations: [
          { ...(local.tables.locations ?? []).find((r) => r.id === 'l2')!, is_default: 1, updated_at: 200 },
        ],
      },
      tombstones: [{ tableName: 'locations', id: 'l1', deletedAt: 200 }],
    };

    await applyPlan(driver, reconcile(local, remote, { offset: 0, dictionary }), dictionary);

    expect(await defaults()).toEqual(['l2']); // l1 deleted, l2 the sole default — no abort
  });

  it('restores a backup that carries two defaults, keeping the newer', async () => {
    // A backup taken on a build that hit the bug carries two is_default=1 location rows.
    await insertLocation('l1', 0, 1); // seed the rows so the backup can overwrite them
    await insertLocation('l2', 0, 1);
    const snap = await buildLocalSnapshot(driver, 1);
    const corrupt: SyncSnapshot = {
      ...snap,
      tables: {
        ...snap.tables,
        locations: (snap.tables.locations ?? []).map((r) =>
          r.id === 'l1'
            ? { ...r, is_default: 1, updated_at: 100 }
            : r.id === 'l2'
              ? { ...r, is_default: 1, updated_at: 200 }
              : r,
        ),
      },
    };

    // Without the dedupe the second row's INSERT would trip the index and abort the whole restore.
    await restoreSnapshot(driver, corrupt);
    expect(await defaults()).toEqual(['l2']);
  });

  it('restores a backup that nominates a different default than the local one, adopting the backup', async () => {
    await insertLocation('l1', 1, 100); // local default is l1
    await insertLocation('l2', 0, 50);
    // A clean backup that makes l2 the default instead — restore must clear l1 before writing l2.
    const snap = await buildLocalSnapshot(driver, 1);
    const backup: SyncSnapshot = {
      ...snap,
      tables: {
        ...snap.tables,
        locations: (snap.tables.locations ?? []).map((r) =>
          r.id === 'l1'
            ? { ...r, is_default: 0 }
            : r.id === 'l2'
              ? { ...r, is_default: 1, updated_at: 200 }
              : r,
        ),
      },
    };

    await restoreSnapshot(driver, backup);
    expect(await defaults()).toEqual(['l2']);
  });

  it('clones a remote snapshot carrying two defaults down to one', async () => {
    await insertLocation('l1', 0, 1);
    await insertLocation('l2', 0, 1);
    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const snap = await buildLocalSnapshot(driver, 1);
    const remote: SyncSnapshot = {
      ...snap,
      tables: {
        ...snap.tables,
        locations: (snap.tables.locations ?? []).map((r) =>
          r.id === 'l1'
            ? { ...r, is_default: 1, updated_at: 100 }
            : r.id === 'l2'
              ? { ...r, is_default: 1, updated_at: 200 }
              : r,
        ),
      },
    };

    // INSERT OR REPLACE would resolve the index by deleting a whole location; the dedupe prevents it.
    await driver.transaction(buildCloneStatements(remote, dictionary));
    expect(await defaults()).toEqual(['l2']);
  });
});
