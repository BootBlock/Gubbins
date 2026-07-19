/**
 * Unit tests for the pure §405 snapshot integrity repair.
 *
 * The end-to-end proof that an orphan aborts a whole restore lives in
 * `snapshot-integrity.integration.test.ts`, over the real schema. These cover its own decisions —
 * in particular the three ways it could quietly do far more harm than the bug it fixes: taking
 * the seeded system rows for absent parents, cascading a drop through a table it merely failed
 * to read, and stopping one level short on a chain.
 */
import { describe, it, expect } from 'vitest';
import { ADMIN_USER_ID, SYSTEM_USER_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { SqlRow } from '@/db/rpc/driver';
import { repairSnapshotIntegrity } from './snapshot-integrity';
import { SYNC_FORMAT_VERSION, type SyncSnapshot } from './types';

/** A snapshot with only the parts a test names populated. */
function snapshot(parts: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    generatedAt: 1,
    tables: {},
    tombstones: [],
    gaugeHistory: [],
    itemTags: [],
    locationTags: [],
    itemRegions: [],
    itemHistory: [],
    ...parts,
  };
}

const item = (id: string, extra: SqlRow = {}): SqlRow => ({
  id,
  name: id,
  location_id: UNASSIGNED_LOCATION_ID,
  ...extra,
});

describe('repairSnapshotIntegrity (issue #405)', () => {
  it('keeps rows referencing the seeded system rows the snapshot never carries', () => {
    // The system locations and built-in principals are excluded from the snapshot *because*
    // every device already has them. Reading that absence as "parent missing" would re-home or
    // drop essentially the entire inventory — the single worst thing this repair could do.
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: { items: [item('i-1')], locations: [], users: [] },
        itemHistory: [{ id: 'h-1', item_id: 'i-1', actor_user_id: SYSTEM_USER_ID }],
      }),
    );

    expect(result.tables.items?.[0]?.location_id).toBe(UNASSIGNED_LOCATION_ID);
    expect(result.itemHistory).toHaveLength(1);
  });

  // Issue #79: a Bridge token is normally minted against the built-in Admin, who is deliberately
  // absent from the snapshot. Treating that absence as a missing parent would drop the token —
  // and the bridge, which learns about tokens only through the snapshot, would then refuse the
  // very credential the operator just created.
  it('keeps an API token owned by a built-in principal the snapshot never carries', () => {
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: {
          users: [],
          api_tokens: [{ id: 'tok-1', user_id: ADMIN_USER_ID, name: 'Home Assistant' }],
        },
      }),
    );

    expect(result.tables.api_tokens).toHaveLength(1);
  });

  it('drops an API token whose owner did not survive the read', () => {
    // The column is NOT NULL / ON DELETE CASCADE: a credential must never outlive its account,
    // so there is no re-attribution to fall back on the way the history ledger has.
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: {
          users: [{ id: 'u-1' }],
          api_tokens: [{ id: 'tok-1', user_id: 'u-gone', name: 'Orphan' }],
        },
      }),
    );

    expect(result.tables.api_tokens).toHaveLength(0);
  });

  it('re-attributes a history entry whose author is absent rather than losing the entry', () => {
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: { items: [item('i-1')], users: [{ id: ADMIN_USER_ID }] },
        itemHistory: [{ id: 'h-1', item_id: 'i-1', actor_user_id: 'u-late' }],
      }),
    );

    // What happened is a fact worth keeping even when who did it can no longer be resolved —
    // mirroring the column's own ON DELETE SET DEFAULT.
    expect(result.itemHistory).toHaveLength(1);
    expect(result.itemHistory?.[0]?.actor_user_id).toBe(SYSTEM_USER_ID);
  });

  it('re-homes an item whose location is absent instead of dropping the item', () => {
    const result = repairSnapshotIntegrity(
      snapshot({ tables: { items: [item('i-1', { location_id: 'loc-late' })], locations: [] } }),
    );

    expect(result.tables.items).toHaveLength(1);
    expect(result.tables.items?.[0]?.location_id).toBe(UNASSIGNED_LOCATION_ID);
  });

  it('cascades a drop down a two-deep chain in a single pass', () => {
    // locations → location_photos → location_regions. The photo's location is absent, so the
    // photo goes; the region hanging off that photo must go with it, not dangle one level down.
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: {
          locations: [],
          location_photos: [{ id: 'p-1', location_id: 'loc-late' }],
          location_regions: [{ id: 'r-1', photo_id: 'p-1' }],
          items: [item('i-1')],
        },
        itemRegions: [{ itemId: 'i-1', regionId: 'r-1' }],
      }),
    );

    expect(result.tables.location_photos).toEqual([]);
    expect(result.tables.location_regions).toEqual([]);
    expect(result.itemRegions).toEqual([]);
  });

  it('treats an unreadable parent table as intact rather than cascading the loss', () => {
    // Rescue mode: `items` is empty because it could not be read, not because it has no rows.
    // Repairing against that would take every image, alias and history entry with it and turn a
    // partial salvage into an almost-empty file.
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: { items: [], item_images: [{ id: 'img-1', item_id: 'i-1' }] },
        itemTags: [{ itemId: 'i-1', tagId: 't-1' }],
        itemHistory: [{ id: 'h-1', item_id: 'i-1', actor_user_id: SYSTEM_USER_ID }],
      }),
      { unreadableTables: new Set(['items', 'tags']) },
    );

    expect(result.tables.item_images).toHaveLength(1);
    expect(result.itemTags).toHaveLength(1);
    expect(result.itemHistory).toHaveLength(1);
  });

  it('drops a gauge delta whose item is absent', () => {
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: { items: [item('i-1')] },
        itemHistory: [
          { id: 'h-1', item_id: 'i-1', actor_user_id: SYSTEM_USER_ID },
          { id: 'h-2', item_id: 'i-late', actor_user_id: SYSTEM_USER_ID },
        ],
        gaugeHistory: [
          { id: 'h-1', itemId: 'i-1', netValueDelta: 5, createdAt: 1 },
          { id: 'h-2', itemId: 'i-late', netValueDelta: 7, createdAt: 2 },
        ],
      }),
    );

    // A delta replayed for an item the snapshot does not carry would resolve the §7.3
    // Delta-CRDT against nothing.
    expect(result.itemHistory.map((row) => row.id)).toEqual(['h-1']);
    expect(result.gaugeHistory.map((delta) => delta.id)).toEqual(['h-1']);
  });

  it('keeps the gauge deltas when only the ledger read failed', () => {
    // The deltas and the ledger are separate queries — the gauge read carries its own `WHERE`,
    // and paging `item_history` can fail on its own — so an empty `itemHistory` does not mean
    // there are no gauge deltas. Keying the deltas off the surviving ledger rows would discard
    // every one of them here, which is exactly the cascade the unreadable guard exists to stop.
    const result = repairSnapshotIntegrity(
      snapshot({
        tables: { items: [item('i-1')] },
        itemHistory: [],
        gaugeHistory: [{ id: 'h-1', itemId: 'i-1', netValueDelta: 5, createdAt: 1 }],
      }),
      { unreadableTables: new Set(['item_history']) },
    );

    expect(result.gaugeHistory).toHaveLength(1);
  });

  it('leaves a consistent snapshot untouched', () => {
    const input = snapshot({
      tables: { items: [item('i-1')], tags: [{ id: 't-1' }] },
      itemTags: [{ itemId: 'i-1', tagId: 't-1' }],
    });

    const result = repairSnapshotIntegrity(input);

    expect(result.tables.items).toEqual(input.tables.items);
    expect(result.itemTags).toEqual(input.itemTags);
  });
});
