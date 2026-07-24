/**
 * Issues #157 / #192: `supplier_parts` carries two independent one-of-N flags per item —
 * `is_preferred` (valuation) and `is_price_source` (which supplier a price refresh fetches). Each
 * is maintained by an app-level demote-then-set, which per-row LWW cannot see across: two devices
 * that each pin a *different* supplier part offline converge to two rows sharing the flag. Left
 * alone that double-orders an item (#157) or refreshes the wrong supplier's cost (#192).
 *
 * The fix is a schema partial unique index (at most one flagged row per item) plus the cross-row
 * repair `reconcile` performs before the merge applies. The pure tests assert the repair's plan;
 * the integration tests run it over `node:sqlite` with the real migrations, because the claim that
 * the merge no longer trips the index is about what the database actually does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { SYNC_TABLES, ITEM_HISTORY_TABLE } from '@/db/repositories/tombstone';
import { reconcile } from './reconcile';
import { applyPlan, buildLocalSnapshot } from './snapshot';
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
  it('reduces two converged price-source rows to the newest, demoting the local loser', () => {
    // Local pinned p1; the remote pinned p2 more recently. LWW leaves p1 (local-only change) and
    // makes p2 an upsert, so both end flagged — the exact converged bug.
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

    expect(plan.flagRepairs).toEqual([
      { table: 'supplier_parts', itemId: 'i1', column: 'is_price_source', winnerId: 'p2' },
    ]);
    // p1 is a stored loser: handled by the demoting UPDATE, never added as an upsert.
    expect(plan.localUpserts.map((u) => u.row.id)).toEqual(['p2']);
    expect(plan.localUpserts[0]!.row.is_price_source).toBe(1);
  });

  it('zeroes the flag on a losing *upsert* row so its own write does not re-pin it', () => {
    // Both rows arrive newer from the remote, so both are upserts; the older-stamped one loses.
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

    expect(plan.flagRepairs).toEqual([
      { table: 'supplier_parts', itemId: 'i1', column: 'is_price_source', winnerId: 'p1' },
    ]);
    const byId = new Map(plan.localUpserts.map((u) => [u.row.id, u.row]));
    expect(byId.get('p1')!.is_price_source).toBe(1);
    expect(byId.get('p2')!.is_price_source).toBe(0); // loser upsert demoted in place
  });

  it('breaks an exact updated_at tie by the smaller id, so both devices agree on the winner', () => {
    const local = snapshot({ supplier_parts: [part({ id: 'p-b', item_id: 'i1', updated_at: 10 })] });
    const remote = snapshot({
      supplier_parts: [
        part({ id: 'p-b', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
        part({ id: 'p-a', item_id: 'i1', is_price_source: 1, updated_at: 200 }),
      ],
    });

    const plan = reconcile(local, remote, opts);

    expect(plan.flagRepairs[0]!.winnerId).toBe('p-a');
    expect(new Map(plan.localUpserts.map((u) => [u.row.id, u.row])).get('p-b')!.is_price_source).toBe(0);
  });

  it('repairs the two flags independently — a preferred contest and a price-source contest at once', () => {
    const local = snapshot({
      supplier_parts: [
        part({ id: 'p1', item_id: 'i1', is_preferred: 1, updated_at: 100 }),
        part({ id: 'p2', item_id: 'i1', updated_at: 50 }),
      ],
    });
    const remote = snapshot({
      supplier_parts: [
        part({ id: 'p2', item_id: 'i1', is_preferred: 1, updated_at: 200 }),
        part({ id: 'p1', item_id: 'i1', is_preferred: 1, is_price_source: 1, updated_at: 100 }),
        part({ id: 'p3', item_id: 'i1', is_price_source: 1, updated_at: 300 }),
      ],
    });

    const plan = reconcile(local, remote, opts);

    const repairs = new Map(plan.flagRepairs.map((r) => [r.column, r.winnerId]));
    expect(repairs.get('is_preferred')).toBe('p2'); // 200 beats p1's 100
    expect(repairs.get('is_price_source')).toBe('p3'); // 300 beats p1's 100
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

  it('the partial unique index forbids a second pinned price source for one item', async () => {
    await insertPart('p1', { price: 1 });
    await expect(insertPart('p2', { price: 1 })).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('the partial unique index forbids a second preferred supplier part for one item', async () => {
    await insertPart('p1', { pref: 1 });
    await expect(insertPart('p2', { pref: 1 })).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('the merge converges two pinned rows to one without tripping the index', async () => {
    // This device pinned p1; a peer pinned p2 more recently. Seed the local state, then craft the
    // remote the peer would push and run the real reconcile + apply over it.
    await insertPart('p1', { price: 1 }, 100);
    await insertPart('p2', { price: 0 }, 50);

    const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
    const local = await buildLocalSnapshot(driver, 1);
    const remoteParts = (local.tables.supplier_parts ?? []).map((row) =>
      String(row.id) === 'p2' ? { ...row, is_price_source: 1, updated_at: 200 } : row,
    );
    const remote: SyncSnapshot = { ...local, tables: { ...local.tables, supplier_parts: remoteParts } };

    const plan = reconcile(local, remote, { offset: 0, dictionary });
    // The apply must not throw — the demotion frees the index before the winner's write.
    await applyPlan(driver, plan, dictionary);

    const rows = await driver.query<{ id: string; is_price_source: number }>(
      'SELECT id, is_price_source FROM supplier_parts WHERE item_id = ? ORDER BY id;',
      ['i1'],
    );
    const pinned = rows.filter((r) => Number(r.is_price_source) === 1);
    expect(pinned.map((r) => r.id)).toEqual(['p2']); // exactly one, the newer pin
  });
});
