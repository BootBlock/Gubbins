import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import type { SqlRow } from '@/db/rpc/driver';
import type { GaugeHistoryDelta, SyncSnapshot, Tombstone } from './types';

// A permissive dictionary so sanitisation keeps the columns the tests assert on.
const DICTIONARY = {
  locations: ['id', 'name', 'parent_id', 'updated_at'],
  categories: ['id', 'name', 'updated_at'],
  items: [
    'id',
    'name',
    'location_id',
    'tracking_mode',
    'gross_capacity',
    'current_net_value',
    'updated_at',
  ],
  item_aliases: ['id', 'item_id', 'alias', 'updated_at'],
  capabilities: ['id', 'item_id', 'key', 'updated_at'],
  contacts: ['id', 'name', 'updated_at'],
  checkouts: ['id', 'item_id', 'contact_id', 'updated_at'],
};

function snapshot(partial: {
  tables?: Partial<Record<string, SqlRow[]>>;
  tombstones?: Tombstone[];
  gaugeHistory?: GaugeHistoryDelta[];
}): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: partial.tables ?? {},
    tombstones: partial.tombstones ?? [],
    gaugeHistory: partial.gaugeHistory ?? [],
  };
}

const opts = { offset: 0, dictionary: DICTIONARY };

describe('reconcile (§7.3 / §7.5)', () => {
  it('returns an empty plan when there is no remote yet', () => {
    const local = snapshot({ tables: { items: [{ id: 'a', name: 'x', updated_at: 1 }] } });
    expect(reconcile(local, null, opts).localUpserts).toHaveLength(0);
  });

  it('downloads a row that exists only on the remote', () => {
    const local = snapshot({});
    const remote = snapshot({
      tables: { contacts: [{ id: 'c1', name: 'Remote', updated_at: 5 }] },
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.localUpserts).toEqual([
      { table: 'contacts', row: { id: 'c1', name: 'Remote', updated_at: 5 } },
    ]);
  });

  it('LWW: the strictly-newer remote row wins; equal/older does not', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Local', updated_at: 10 }] } });
    const remoteNewer = snapshot({
      tables: { contacts: [{ id: 'c1', name: 'Remote', updated_at: 20 }] },
    });
    expect(reconcile(local, remoteNewer, opts).localUpserts[0]!.row.name).toBe('Remote');

    const remoteOlder = snapshot({
      tables: { contacts: [{ id: 'c1', name: 'Remote', updated_at: 5 }] },
    });
    expect(reconcile(local, remoteOlder, opts).localUpserts).toHaveLength(0);
  });

  it('applies the clock offset to local timestamps before diffing', () => {
    // Local says 10, remote says 15. With +10 offset, local becomes 20 → local wins.
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Local', updated_at: 10 }] } });
    const remote = snapshot({
      tables: { contacts: [{ id: 'c1', name: 'Remote', updated_at: 15 }] },
    });
    expect(reconcile(local, remote, { ...opts, offset: 10 }).localUpserts).toHaveLength(0);
  });

  it('strips unknown columns from a downloaded row (§7.3 sanitisation)', () => {
    const remote = snapshot({
      tables: { contacts: [{ id: 'c1', name: 'R', updated_at: 1, future_col: 'boom' }] },
    });
    const plan = reconcile(snapshot({}), remote, opts);
    expect(plan.localUpserts[0]!.row).not.toHaveProperty('future_col');
  });

  it('a remote tombstone deletes the local row', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'L', updated_at: 5 }] } });
    const remote = snapshot({ tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 10 }] });
    const plan = reconcile(local, remote, opts);
    expect(plan.localDeletes).toEqual([{ tableName: 'contacts', id: 'c1', deletedAt: 10 }]);
  });

  it('a strictly-newer local row resurrects against an older remote tombstone', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'L', updated_at: 20 }] } });
    const remote = snapshot({ tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 10 }] });
    const plan = reconcile(local, remote, opts);
    expect(plan.localDeletes).toHaveLength(0);
    expect(plan.localUpserts).toHaveLength(0); // kept as-is, pushed by the orchestrator
  });

  it('§7.5.2 re-parents an item whose location was deleted on the remote', () => {
    const local = snapshot({
      tables: {
        locations: [{ id: 'loc1', name: 'Shelf', parent_id: null, updated_at: 1 }],
        items: [{ id: 'i1', name: 'Widget', location_id: 'loc1', tracking_mode: 'DISCRETE', updated_at: 1 }],
      },
    });
    const remote = snapshot({ tombstones: [{ tableName: 'locations', id: 'loc1', deletedAt: 50 }] });
    const plan = reconcile(local, remote, opts);

    expect(plan.localDeletes.some((d) => d.id === 'loc1')).toBe(true);
    expect(plan.reparented).toEqual([{ itemId: 'i1', fromLocationId: 'loc1' }]);
    const itemUpsert = plan.localUpserts.find((u) => u.table === 'items' && u.row.id === 'i1');
    expect(itemUpsert?.row.location_id).toBe(UNASSIGNED_LOCATION_ID);
  });

  it('§7.5.2 re-parents an incoming remote item pointing at a missing location', () => {
    const local = snapshot({});
    const remote = snapshot({
      tables: {
        items: [{ id: 'i1', name: 'Orphan', location_id: 'ghost', tracking_mode: 'DISCRETE', updated_at: 9 }],
      },
    });
    const plan = reconcile(local, remote, opts);
    const itemUpsert = plan.localUpserts.find((u) => u.table === 'items');
    expect(itemUpsert?.row.location_id).toBe(UNASSIGNED_LOCATION_ID);
    expect(plan.reparented).toEqual([{ itemId: 'i1', fromLocationId: 'ghost' }]);
  });

  it('§7.5.3 rejects a location move that would create a cycle', () => {
    // Local: locY nests under locX. Remote wants to move locX under locY → cycle.
    const local = snapshot({
      tables: {
        locations: [
          { id: 'locX', name: 'X', parent_id: null, updated_at: 1 },
          { id: 'locY', name: 'Y', parent_id: 'locX', updated_at: 1 },
        ],
      },
    });
    const remote = snapshot({
      tables: {
        locations: [{ id: 'locX', name: 'X', parent_id: 'locY', updated_at: 99 }],
      },
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.rejectedCycles).toContain('locX');
    expect(plan.localUpserts.some((u) => u.table === 'locations' && u.row.id === 'locX')).toBe(false);
  });

  it('§7.3 Delta-CRDT replays concurrent gauge usage instead of LWW', () => {
    const localItems = [
      {
        id: 'spool',
        name: 'PLA',
        location_id: UNASSIGNED_LOCATION_ID,
        tracking_mode: 'CONSUMABLE_GAUGE',
        gross_capacity: 1000,
        current_net_value: 955, // local used 45
        updated_at: 10,
      },
    ];
    const remoteItems = [
      { ...localItems[0]!, current_net_value: 990, updated_at: 20 }, // remote used 10
    ];
    const local = snapshot({
      tables: { items: localItems },
      gaugeHistory: [{ id: 'hA', itemId: 'spool', netValueDelta: -45, createdAt: 1 }],
    });
    const remote = snapshot({
      tables: { items: remoteItems },
      gaugeHistory: [{ id: 'hB', itemId: 'spool', netValueDelta: -10, createdAt: 2 }],
    });
    const plan = reconcile(local, remote, opts);
    // Both usages survive: 1000 − 45 − 10 = 945, NOT the LWW value of 990.
    expect(plan.gaugeResolutions).toEqual([{ itemId: 'spool', netValue: 945 }]);
  });

  describe('§4 alias-text collision (UNIQUE(alias) safety)', () => {
    it('downloads a non-colliding remote alias normally', () => {
      const remote = snapshot({
        tables: { item_aliases: [{ id: 'al1', item_id: 'i1', alias: 'NE555', updated_at: 5 }] },
      });
      const plan = reconcile(snapshot({}), remote, opts);
      expect(plan.localUpserts).toEqual([
        { table: 'item_aliases', row: { id: 'al1', item_id: 'i1', alias: 'NE555', updated_at: 5 } },
      ]);
    });

    it('newer incoming alias wins the text; the local conflicting row is deleted', () => {
      const local = snapshot({
        tables: { item_aliases: [{ id: 'localAl', item_id: 'iLocal', alias: 'shared', updated_at: 10 }] },
      });
      const remote = snapshot({
        tables: { item_aliases: [{ id: 'remoteAl', item_id: 'iRemote', alias: 'SHARED', updated_at: 20 }] },
      });
      const plan = reconcile(local, remote, opts);
      // Remote row is upserted, local conflicting row is tombstoned (frees the UNIQUE text).
      expect(plan.localUpserts.some((u) => u.row.id === 'remoteAl')).toBe(true);
      expect(plan.localDeletes).toContainEqual({ tableName: 'item_aliases', id: 'localAl', deletedAt: 20 });
    });

    it('older incoming alias loses: the upsert is dropped, the local mapping stands', () => {
      const local = snapshot({
        tables: { item_aliases: [{ id: 'localAl', item_id: 'iLocal', alias: 'shared', updated_at: 30 }] },
      });
      const remote = snapshot({
        tables: { item_aliases: [{ id: 'remoteAl', item_id: 'iRemote', alias: 'SHARED', updated_at: 20 }] },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.row.id === 'remoteAl')).toBe(false);
      expect(plan.localDeletes).toHaveLength(0);
    });

    it('a same-id alias update is not treated as a collision', () => {
      const local = snapshot({
        tables: { item_aliases: [{ id: 'al1', item_id: 'i1', alias: 'NE555', updated_at: 5 }] },
      });
      const remote = snapshot({
        tables: { item_aliases: [{ id: 'al1', item_id: 'i1', alias: 'NE555', updated_at: 9 }] },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.row.id === 'al1')).toBe(true);
      expect(plan.localDeletes).toHaveLength(0);
    });
  });
});
