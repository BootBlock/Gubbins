import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import { buildConflict, conflictId, entityLabelFor } from './conflict-detect';
import { diffConflict } from './conflict-diff';
import type { SqlRow } from '@/db/rpc/driver';
import type { GaugeHistoryDelta, ItemTagEdge, SyncSnapshot, Tombstone } from './types';

const DICTIONARY = {
  contacts: ['id', 'name', 'updated_at'],
  items: ['id', 'name', 'location_id', 'tracking_mode', 'current_net_value', 'quantity', 'updated_at'],
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
    locationTags: [],
    itemHistory: partial.itemHistory ?? [],
  };
}

// conflictSince = 100: a local row edited after that instant is "changed since last sync".
const opts = { offset: 0, dictionary: DICTIONARY, conflictSince: 100, now: 999 };

describe('conflict detection (#72)', () => {
  it('flags a local edit overwritten by a concurrent remote change', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Mine', updated_at: 150 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Theirs', updated_at: 200 }] } });
    const plan = reconcile(local, remote, opts);

    expect(plan.localUpserts[0]!.row.name).toBe('Theirs'); // LWW still applies the winner
    expect(plan.conflicts).toHaveLength(1);
    const c = plan.conflicts[0]!;
    expect(c).toMatchObject({
      tableName: 'contacts',
      rowId: 'c1',
      kind: 'UPDATE',
      entityLabel: 'Mine',
      detectedAt: 999,
    });
    expect(c.localVersion.name).toBe('Mine');
    expect(c.remoteVersion?.name).toBe('Theirs');
  });

  it('does NOT flag when only the remote changed (this device merely catching up)', () => {
    // Local unchanged since last sync (updated_at 50 < conflictSince 100); remote is newer.
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Old', updated_at: 50 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'New', updated_at: 200 }] } });
    const plan = reconcile(local, remote, opts);

    expect(plan.localUpserts).toHaveLength(1); // still pulled
    expect(plan.conflicts).toHaveLength(0); // but no lost local work
  });

  it('does NOT flag when the local edit wins LWW (no data lost)', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Mine', updated_at: 300 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Theirs', updated_at: 200 }] } });
    const plan = reconcile(local, remote, opts);

    expect(plan.localUpserts).toHaveLength(0); // local wins, nothing applied
    expect(plan.conflicts).toHaveLength(0);
  });

  it('does NOT flag when the winning value is identical (churn, not a real collision)', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 150 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 200 }] } });
    const plan = reconcile(local, remote, opts);

    expect(plan.conflicts).toHaveLength(0);
  });

  it('flags a local edit lost to a concurrent remote deletion (kind: DELETE)', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Mine', updated_at: 150 }] } });
    const remote = snapshot({
      tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 200 }],
    });
    const plan = reconcile(local, remote, opts);

    expect(plan.localDeletes).toHaveLength(1); // deletion still applied
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ kind: 'DELETE', rowId: 'c1' });
    expect(plan.conflicts[0]!.remoteVersion).toBeNull();
  });

  it('does NOT flag a deletion of a row the device had not re-edited since last sync', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Old', updated_at: 50 }] } });
    const remote = snapshot({ tombstones: [{ tableName: 'contacts', id: 'c1', deletedAt: 200 }] });
    const plan = reconcile(local, remote, opts);

    expect(plan.localDeletes).toHaveLength(1);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('detection is off with no prior sync (conflictSince undefined/0)', () => {
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Mine', updated_at: 150 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Theirs', updated_at: 200 }] } });
    expect(reconcile(local, remote, { offset: 0, dictionary: DICTIONARY }).conflicts).toHaveLength(0);
    expect(
      reconcile(local, remote, { offset: 0, dictionary: DICTIONARY, conflictSince: 0 }).conflicts,
    ).toHaveLength(0);
  });

  it('does NOT flag a gauge/derived-only change on items (CRDT + trigger columns, not LWW)', () => {
    // Both devices consumed a gauge / moved stock: only current_net_value + quantity differ.
    // Those are delta-CRDT / trigger-derived, not lost LWW edits — no conflict should fire.
    const local = snapshot({
      tables: {
        items: [
          {
            id: 'i1',
            name: 'Spool',
            tracking_mode: 'CONSUMABLE_GAUGE',
            current_net_value: 40,
            quantity: 1,
            updated_at: 150,
          },
        ],
      },
    });
    const remote = snapshot({
      tables: {
        items: [
          {
            id: 'i1',
            name: 'Spool',
            tracking_mode: 'CONSUMABLE_GAUGE',
            current_net_value: 55,
            quantity: 2,
            updated_at: 200,
          },
        ],
      },
    });
    expect(reconcile(local, remote, opts).conflicts).toHaveLength(0);
  });

  it('still flags a real field change on items, hiding the CRDT/derived columns from the diff', () => {
    const local = snapshot({
      tables: {
        items: [
          {
            id: 'i1',
            name: 'Mine',
            tracking_mode: 'CONSUMABLE_GAUGE',
            current_net_value: 40,
            quantity: 1,
            updated_at: 150,
          },
        ],
      },
    });
    const remote = snapshot({
      tables: {
        items: [
          {
            id: 'i1',
            name: 'Theirs',
            tracking_mode: 'CONSUMABLE_GAUGE',
            current_net_value: 55,
            quantity: 2,
            updated_at: 200,
          },
        ],
      },
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.conflicts).toHaveLength(1);
    const diffs = diffConflict(plan.conflicts[0]!);
    expect(diffs.map((d) => d.column)).toEqual(['name']); // current_net_value / quantity hidden
  });

  it('applies the clock offset when deciding "changed since last sync"', () => {
    // Local updated_at 50, but +60 offset → 110 > conflictSince 100 → edited since sync.
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Mine', updated_at: 50 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Theirs', updated_at: 200 }] } });
    const plan = reconcile(local, remote, { ...opts, offset: 60 });
    expect(plan.conflicts).toHaveLength(1);
  });
});

describe('conflict record shaping', () => {
  it('builds a deterministic id from table, row and local updated_at', () => {
    expect(conflictId('items', 'x1', 42)).toBe('items:x1:42');
  });

  it('re-detecting the same discarded version yields a stable id', () => {
    const row: SqlRow = { id: 'x1', name: 'A', updated_at: 42 };
    expect(buildConflict('items', row, null, 1).id).toBe(buildConflict('items', row, null, 2).id);
  });

  it('labels a row by its name, falling back to a short id', () => {
    expect(entityLabelFor('items', { id: 'abcdef12-0000', name: 'Drill', updated_at: 1 })).toBe('Drill');
    expect(entityLabelFor('items', { id: 'abcdef12-0000', updated_at: 1 })).toBe('items abcdef12');
  });
});

describe('conflict diff (#72)', () => {
  it('lists only the columns that differ, ignoring bookkeeping', () => {
    const conflict = buildConflict(
      'items',
      { id: 'i1', name: 'Mine', location_id: 'L', updated_at: 150, created_at: 1 },
      { id: 'i1', name: 'Theirs', location_id: 'L', updated_at: 200, created_at: 1 },
      999,
    );
    const diffs = diffConflict(conflict);
    expect(diffs).toEqual([{ column: 'name', mine: 'Mine', theirs: 'Theirs' }]);
  });

  it('lists the populated local columns for a DELETE (theirs = null)', () => {
    const conflict = buildConflict(
      'items',
      { id: 'i1', name: 'Mine', location_id: '', updated_at: 150 },
      null,
      999,
    );
    const diffs = diffConflict(conflict);
    expect(diffs).toEqual([{ column: 'name', mine: 'Mine', theirs: null }]);
  });
});
