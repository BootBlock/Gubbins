/**
 * What a last-write-wins merge overwrote (issue #487) — the pure half.
 *
 * Two devices edit one item offline; the merge keeps one version and discards the other. Before
 * this, the loser's values went with nothing recorded, so on the device that lost, the Activity
 * Log read as though its edit still stood. These tests pin the three halves of the fix: the
 * field-level diff records the values it discarded, the record is raised only for a genuine
 * concurrent collision, and its id is derived so a replayed merge cannot duplicate it.
 */
import { describe, it, expect } from 'vitest';
import type { SqlRow } from '@/db/rpc/driver';
import { labelsFor, mergeOverwriteId, overwrittenFields } from './merge-audit';
import { reconcile } from './reconcile';
import type { GaugeHistoryDelta, ItemTagEdge, SyncSnapshot, Tombstone } from './types';

const ITEM_COLUMNS = [
  'id',
  'name',
  'barcode',
  'manufacturer',
  'unit_cost',
  'reorder_point',
  'description',
  'quantity',
  'updated_at',
];

const DICTIONARY = { items: ITEM_COLUMNS, contacts: ['id', 'name', 'updated_at'] };

function snapshot(tables: Partial<Record<string, SqlRow[]>>): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables,
    tombstones: [] as Tombstone[],
    gaugeHistory: [] as GaugeHistoryDelta[],
    itemTags: [] as ItemTagEdge[],
    locationTags: [],
    itemHistory: [],
  };
}

/** `conflictSince: 100` — a local row stamped after that instant was edited since the last sync. */
const OPTIONS = { offset: 0, dictionary: DICTIONARY, conflictSince: 100, now: 999 };

describe('overwrittenFields', () => {
  it('names each audited field the winner changes, keeping the value it discards', () => {
    const losing = { id: 'i1', name: 'Drill', barcode: '111', reorder_point: 4 };
    const winning = { id: 'i1', name: 'Hammer drill', barcode: '111', reorder_point: 9 };

    expect(overwrittenFields(losing, winning)).toEqual([
      { field: 'name', from: 'Drill', to: 'Hammer drill' },
      { field: 'reorderPoint', from: 4, to: 9 },
    ]);
  });

  it('reports a money field in major units, as the edit path does (issue #286)', () => {
    // Stored micro-units; the ledger speaks the major units the item DTO and `ATTRIBUTES_CHANGED`
    // both use, so one reader handles a price's history whoever changed it.
    const changes = overwrittenFields({ unit_cost: 2_500_000 }, { unit_cost: 3_750_000 });
    expect(changes).toEqual([{ field: 'unitCost', from: 2.5, to: 3.75 }]);
  });

  it('records a field cleared to nothing, and one filled in from nothing', () => {
    expect(overwrittenFields({ barcode: '111', mpn: null }, { barcode: null, mpn: 'MPN-7' })).toEqual([
      { field: 'mpn', from: null, to: 'MPN-7' },
      { field: 'barcode', from: '111', to: null },
    ]);
  });

  it('ignores the columns the edit path deliberately leaves silent', () => {
    // Free-form prose and the trigger-derived / CRDT-merged columns: none of them is an audited
    // attribute, and `quantity` is not even decided by this upsert.
    const losing = { description: 'Mine', notes: 'Mine', quantity: 3, current_net_value: 10 };
    const winning = { description: 'Theirs', notes: 'Theirs', quantity: 8, current_net_value: 40 };
    expect(overwrittenFields(losing, winning)).toEqual([]);
  });

  it('ignores a column the winner does not carry', () => {
    // The upsert writes `SET col = excluded.col` only for the winner's own columns, so a column
    // an older peer's schema lacks is never written — reading its absence as a loss would record
    // an overwrite that never happens.
    expect(overwrittenFields({ barcode: '111', mpn: 'MPN-7' }, { barcode: '222' })).toEqual([
      { field: 'barcode', from: '111', to: '222' },
    ]);
  });

  it('narrows a bigint to a number, so the record can be serialised', () => {
    const [change] = overwrittenFields({ reorder_point: 4n }, { reorder_point: 9n });
    expect(change).toEqual({ field: 'reorderPoint', from: 4, to: 9 });
    expect(() => JSON.stringify(change)).not.toThrow();
  });

  it('gives every recorded change a British-English label, in registry order', () => {
    const changes = overwrittenFields(
      { unit_cost: 1_000_000, name: 'Drill' },
      { unit_cost: 2_000_000, name: 'Driver' },
    );
    expect(labelsFor(changes)).toEqual(['name', 'unit cost']);
  });
});

describe('mergeOverwriteId', () => {
  it('is the same id for the same overwrite, so a replayed merge cannot duplicate the entry', async () => {
    // The ledger reconciles by union-of-id: a random id would append a fresh duplicate every time
    // the same merge ran again — after a sync that applied but failed before its watermark moved.
    await expect(mergeOverwriteId('i1', 150, 200)).resolves.toBe(await mergeOverwriteId('i1', 150, 200));
  });

  it('is a distinct id per item, per discarded version and per adopted version', async () => {
    const base = await mergeOverwriteId('i1', 150, 200);
    expect(await mergeOverwriteId('i2', 150, 200)).not.toBe(base);
    expect(await mergeOverwriteId('i1', 151, 200)).not.toBe(base);
    expect(await mergeOverwriteId('i1', 150, 201)).not.toBe(base);
  });

  it('is a canonical version-5 UUID, as every id-shaped assumption in the app expects', async () => {
    expect(await mergeOverwriteId('i1', 150, 200)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('reconcile — planning the overwrite record (issue #487)', () => {
  it('records what a concurrent remote edit overwrote', () => {
    const local = snapshot({ items: [{ id: 'i1', name: 'Mine', barcode: '111', updated_at: 150 }] });
    const remote = snapshot({ items: [{ id: 'i1', name: 'Theirs', barcode: '111', updated_at: 200 }] });

    const plan = reconcile(local, remote, OPTIONS);

    expect(plan.mergeOverwrites).toEqual([
      {
        itemId: 'i1',
        losingUpdatedAt: 150,
        winningUpdatedAt: 200,
        changes: [{ field: 'name', from: 'Mine', to: 'Theirs' }],
      },
    ]);
  });

  it('records nothing when this device simply receives a peer edit it never touched', () => {
    // The ordinary pull. Nothing local was overwritten, and the peer's own `ATTRIBUTES_CHANGED`
    // entry travels with it in the unioned ledger — a second entry would be noise on every sync.
    const local = snapshot({ items: [{ id: 'i1', name: 'Mine', updated_at: 50 }] });
    const remote = snapshot({ items: [{ id: 'i1', name: 'Theirs', updated_at: 200 }] });

    expect(reconcile(local, remote, OPTIONS).mergeOverwrites).toEqual([]);
  });

  it('records nothing on a first-ever sync, which has no prior common state', () => {
    const local = snapshot({ items: [{ id: 'i1', name: 'Mine', updated_at: 150 }] });
    const remote = snapshot({ items: [{ id: 'i1', name: 'Theirs', updated_at: 200 }] });

    const plan = reconcile(local, remote, { offset: 0, dictionary: DICTIONARY, now: 999 });
    expect(plan.mergeOverwrites).toEqual([]);
  });

  it('records nothing when only unaudited columns differ', () => {
    const local = snapshot({
      items: [{ id: 'i1', name: 'Drill', description: 'Mine', updated_at: 150 }],
    });
    const remote = snapshot({
      items: [{ id: 'i1', name: 'Drill', description: 'Theirs', updated_at: 200 }],
    });

    expect(reconcile(local, remote, OPTIONS).mergeOverwrites).toEqual([]);
  });

  it('records nothing for a losing row on another table', () => {
    // `item_history` is the item's ledger; a contact has none, so the loss has nowhere to go.
    const local = snapshot({ contacts: [{ id: 'c1', name: 'Mine', updated_at: 150 }] });
    const remote = snapshot({ contacts: [{ id: 'c1', name: 'Theirs', updated_at: 200 }] });

    const plan = reconcile(local, remote, OPTIONS);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.mergeOverwrites).toEqual([]);
  });

  it('records nothing when the remote deleted the row instead of editing it', () => {
    // There is no surviving item to hang the entry on, and the tombstone is the record.
    const local = snapshot({ items: [{ id: 'i1', name: 'Mine', updated_at: 150 }] });
    const remote = {
      ...snapshot({}),
      tombstones: [{ tableName: 'items', id: 'i1', deletedAt: 200 }] as Tombstone[],
    };

    const plan = reconcile(local, remote, OPTIONS);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.mergeOverwrites).toEqual([]);
  });

  it('records one entry per losing item, not one per field', () => {
    const local = snapshot({
      items: [
        { id: 'i1', name: 'Mine', barcode: '111', unit_cost: 1_000_000, updated_at: 150 },
        { id: 'i2', name: 'Also mine', updated_at: 150 },
      ],
    });
    const remote = snapshot({
      items: [
        { id: 'i1', name: 'Theirs', barcode: '222', unit_cost: 2_000_000, updated_at: 200 },
        { id: 'i2', name: 'Also theirs', updated_at: 200 },
      ],
    });

    const plan = reconcile(local, remote, OPTIONS);
    expect(plan.mergeOverwrites.map((o) => o.itemId)).toEqual(['i1', 'i2']);
    expect(plan.mergeOverwrites[0]!.changes.map((c) => c.field)).toEqual(['name', 'barcode', 'unitCost']);
  });
});
