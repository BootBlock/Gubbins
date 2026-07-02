import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import type { SqlRow } from '@/db/rpc/driver';
import type { GaugeHistoryDelta, ItemTagEdge, SyncSnapshot, Tombstone } from './types';

// A permissive dictionary so sanitisation keeps the columns the tests assert on.
const DICTIONARY = {
  locations: ['id', 'name', 'parent_id', 'updated_at'],
  categories: ['id', 'name', 'updated_at'],
  items: ['id', 'name', 'location_id', 'tracking_mode', 'gross_capacity', 'current_net_value', 'updated_at'],
  item_aliases: ['id', 'item_id', 'alias', 'updated_at'],
  capabilities: ['id', 'item_id', 'key', 'updated_at'],
  contacts: ['id', 'name', 'updated_at'],
  checkouts: ['id', 'item_id', 'contact_id', 'updated_at'],
  category_fields: ['id', 'category_id', 'name', 'updated_at'],
  item_field_values: ['id', 'item_id', 'field_id', 'value', 'updated_at'],
  tags: ['id', 'name', 'updated_at'],
  item_history: ['id', 'item_id', 'action', 'net_value_delta', 'note', 'created_at'],
  projects: ['id', 'name', 'updated_at'],
  project_bom_lines: ['id', 'project_id', 'item_id', 'updated_at'],
};

function snapshot(partial: {
  tables?: Partial<Record<string, SqlRow[]>>;
  tombstones?: Tombstone[];
  gaugeHistory?: GaugeHistoryDelta[];
  itemTags?: ItemTagEdge[];
  itemHistory?: SqlRow[];
}): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: partial.tables ?? {},
    tombstones: partial.tombstones ?? [],
    gaugeHistory: partial.gaugeHistory ?? [],
    itemTags: partial.itemTags ?? [],
    itemHistory: partial.itemHistory ?? [],
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

  describe('Phase 11 — Activity Ledger (item_history, union-by-id)', () => {
    // An item that exists on both sides so history rows have a surviving FK parent.
    const item = {
      id: 'i1',
      name: 'Widget',
      location_id: UNASSIGNED_LOCATION_ID,
      tracking_mode: 'DISCRETE',
      updated_at: 1,
    };

    it('unions a remote-only ledger row in; never duplicates one we already hold', () => {
      const local = snapshot({
        tables: { items: [item] },
        itemHistory: [{ id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 1 }],
      });
      const remote = snapshot({
        tables: { items: [item] },
        itemHistory: [
          { id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 1 }, // already local
          { id: 'h2', item_id: 'i1', action: 'ADJUSTED', created_at: 2 }, // new
        ],
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.historyInserts.map((r) => r.id)).toEqual(['h2']);
    });

    it('§7.6.3-A: skips a remote ledger row older than the local prune watermark', () => {
      const local = snapshot({ tables: { items: [item] } });
      const remote = snapshot({
        tables: { items: [item] },
        itemHistory: [
          { id: 'old', item_id: 'i1', action: 'CREATED', created_at: 100 }, // pruned era
          { id: 'new', item_id: 'i1', action: 'ADJUSTED', created_at: 300 },
        ],
      });
      const plan = reconcile(local, remote, { ...opts, historyPrunedBefore: 200 });
      expect(plan.historyInserts.map((r) => r.id)).toEqual(['new']);
    });

    it('drops a ledger row whose item will not survive the merge (FK-safe)', () => {
      // Remote tombstones the item AND carries a history row for it → the row must not
      // be inserted (its FK parent is gone; it would cascade away anyway).
      const local = snapshot({ tables: { items: [item] } });
      const remote = snapshot({
        tombstones: [{ tableName: 'items', id: 'i1', deletedAt: 50 }],
        itemHistory: [{ id: 'h9', item_id: 'i1', action: 'ADJUSTED', created_at: 2 }],
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.historyInserts).toHaveLength(0);
    });

    it('sanitises an unknown column off an incoming ledger row', () => {
      const local = snapshot({ tables: { items: [item] } });
      const remote = snapshot({
        tables: { items: [item] },
        itemHistory: [{ id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 1, future_col: 'boom' }],
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.historyInserts[0]).not.toHaveProperty('future_col');
    });
  });

  describe('Phase 11 — M:N membership (item_tags, tombstone-wins union)', () => {
    const item = {
      id: 'i1',
      name: 'W',
      location_id: UNASSIGNED_LOCATION_ID,
      tracking_mode: 'DISCRETE',
      updated_at: 1,
    };
    const tag = { id: 't1', name: 'esp32', updated_at: 1 };
    const bothSides = { tables: { items: [item], tags: [tag] } };

    it('adds a remote-only edge when both endpoints survive the merge', () => {
      const local = snapshot(bothSides);
      const remote = snapshot({ ...bothSides, itemTags: [{ itemId: 'i1', tagId: 't1' }] });
      const plan = reconcile(local, remote, opts);
      expect(plan.itemTagUpserts).toEqual([{ itemId: 'i1', tagId: 't1' }]);
      expect(plan.itemTagDeletes).toHaveLength(0);
    });

    it('does not add a remote edge whose tag will not exist locally (FK-safe)', () => {
      const local = snapshot({ tables: { items: [item] } }); // no tags
      const remote = snapshot({ tables: { items: [item] }, itemTags: [{ itemId: 'i1', tagId: 'ghost' }] });
      const plan = reconcile(local, remote, opts);
      expect(plan.itemTagUpserts).toHaveLength(0);
    });

    it('a peer tombstone removes an edge we still hold', () => {
      const local = snapshot({ ...bothSides, itemTags: [{ itemId: 'i1', tagId: 't1' }] });
      const remote = snapshot({
        ...bothSides,
        tombstones: [{ tableName: 'item_tags', id: 'i1|t1', deletedAt: 42 }],
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.itemTagDeletes).toEqual([{ itemId: 'i1', tagId: 't1', deletedAt: 42 }]);
      expect(plan.itemTagUpserts).toHaveLength(0);
    });

    it('a local tombstone suppresses a remote edge (removal wins; no re-add)', () => {
      const local = snapshot({
        ...bothSides,
        tombstones: [{ tableName: 'item_tags', id: 'i1|t1', deletedAt: 42 }],
      });
      const remote = snapshot({ ...bothSides, itemTags: [{ itemId: 'i1', tagId: 't1' }] });
      const plan = reconcile(local, remote, opts);
      expect(plan.itemTagUpserts).toHaveLength(0);
      expect(plan.itemTagDeletes).toHaveLength(0); // we never held it locally
    });

    it('leaves a purely-local edge alone (the push half carries it)', () => {
      const local = snapshot({ ...bothSides, itemTags: [{ itemId: 'i1', tagId: 't1' }] });
      const remote = snapshot(bothSides);
      const plan = reconcile(local, remote, opts);
      expect(plan.itemTagUpserts).toHaveLength(0);
      expect(plan.itemTagDeletes).toHaveLength(0);
    });
  });

  describe('Phase 11 — §7.5 child FK guard (no orphan resurrection)', () => {
    it('drops a remote child whose item was deleted on the peer (NOT-NULL FK)', () => {
      // Local holds the item; remote tombstones it and still carries a capability for it.
      const local = snapshot({
        tables: {
          items: [
            {
              id: 'i1',
              name: 'W',
              location_id: UNASSIGNED_LOCATION_ID,
              tracking_mode: 'DISCRETE',
              updated_at: 1,
            },
          ],
        },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'items', id: 'i1', deletedAt: 99 }],
        tables: { capabilities: [{ id: 'c1', item_id: 'i1', key: 'voltage', updated_at: 5 }] },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.id === 'i1')).toBe(true);
      expect(plan.localUpserts.some((u) => u.table === 'capabilities')).toBe(false);
    });

    it('nulls a nullable FK instead of dropping the row (BOM line whose item was removed)', () => {
      const local = snapshot({
        tables: {
          items: [
            {
              id: 'i1',
              name: 'W',
              location_id: UNASSIGNED_LOCATION_ID,
              tracking_mode: 'DISCRETE',
              updated_at: 1,
            },
          ],
          projects: [{ id: 'p1', name: 'Build', updated_at: 1 }],
        },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'items', id: 'i1', deletedAt: 99 }],
        tables: {
          projects: [{ id: 'p1', name: 'Build', updated_at: 1 }],
          project_bom_lines: [{ id: 'l1', project_id: 'p1', item_id: 'i1', updated_at: 5 }],
        },
      });
      const plan = reconcile(local, remote, opts);
      const line = plan.localUpserts.find((u) => u.table === 'project_bom_lines');
      expect(line).toBeDefined();
      expect(line!.row.item_id).toBeNull(); // project kept, broken item link cleared
    });

    it('leaves a child untouched when its parent is simply not in the snapshot', () => {
      // No items table at all → the alias parent is "unknown", not "removed".
      const remote = snapshot({
        tables: { item_aliases: [{ id: 'al1', item_id: 'i1', alias: 'NE555', updated_at: 5 }] },
      });
      const plan = reconcile(snapshot({}), remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'item_aliases')).toBe(true);
    });
  });

  describe('Phase 14 — §7.5 child FK guard for non-item parents', () => {
    it('drops a remote checkout whose contact was deleted on the peer (NOT-NULL FK)', () => {
      // Local holds the contact; remote tombstones it and still carries a loan for it.
      // checkouts.contact_id is NOT NULL → the orphaned checkout upsert must be dropped.
      const local = snapshot({
        tables: { contacts: [{ id: 'c1', name: 'Alex', updated_at: 1 }] },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 99 }],
        tables: { checkouts: [{ id: 'co1', item_id: 'i1', contact_id: 'c1', updated_at: 5 }] },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.tableName === 'contacts' && d.id === 'c1')).toBe(true);
      expect(plan.localUpserts.some((u) => u.table === 'checkouts')).toBe(false);
    });

    it('keeps a checkout whose contact survives the merge', () => {
      const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Alex', updated_at: 1 }] } });
      const remote = snapshot({
        tables: {
          contacts: [{ id: 'c1', name: 'Alex', updated_at: 1 }],
          checkouts: [{ id: 'co1', item_id: 'i1', contact_id: 'c1', updated_at: 5 }],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'checkouts' && u.row.id === 'co1')).toBe(true);
    });

    it('drops an item_field_value when its category cascade-removed the owning field', () => {
      // A category delete cascades category_fields, which cascades item_field_values.
      // The peer still carries the field-value referencing the cascaded field → on the
      // deleting device it must NOT be re-inserted (its category_fields parent is gone).
      const local = snapshot({
        tables: {
          categories: [{ id: 'cat1', name: 'Resistors', updated_at: 1 }],
          category_fields: [{ id: 'f1', category_id: 'cat1', name: 'tolerance', updated_at: 1 }],
        },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'categories', id: 'cat1', deletedAt: 99 }],
        tables: {
          // The peer never saw the delete: it still holds the field and a value for it.
          category_fields: [{ id: 'f1', category_id: 'cat1', name: 'tolerance', updated_at: 1 }],
          item_field_values: [{ id: 'v1', item_id: 'i1', field_id: 'f1', value: '1%', updated_at: 5 }],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.tableName === 'categories' && d.id === 'cat1')).toBe(true);
      // The cascaded field must not be re-upserted, and neither must its value.
      expect(plan.localUpserts.some((u) => u.table === 'category_fields')).toBe(false);
      expect(plan.localUpserts.some((u) => u.table === 'item_field_values')).toBe(false);
    });

    it('keeps an item_field_value when its field (and category) survive', () => {
      const local = snapshot({
        tables: {
          categories: [{ id: 'cat1', name: 'Resistors', updated_at: 1 }],
          category_fields: [{ id: 'f1', category_id: 'cat1', name: 'tolerance', updated_at: 1 }],
        },
      });
      const remote = snapshot({
        tables: {
          categories: [{ id: 'cat1', name: 'Resistors', updated_at: 1 }],
          category_fields: [{ id: 'f1', category_id: 'cat1', name: 'tolerance', updated_at: 1 }],
          item_field_values: [{ id: 'v1', item_id: 'i1', field_id: 'f1', value: '1%', updated_at: 5 }],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'item_field_values' && u.row.id === 'v1')).toBe(true);
    });
  });
});
