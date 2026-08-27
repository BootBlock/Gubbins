import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import { ADMIN_USER_ID, SYSTEM_USER_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import type { SqlRow } from '@/db/rpc/driver';
import type { GaugeHistoryDelta, ItemTagEdge, LocationTagEdge, SyncSnapshot, Tombstone } from './types';

// A permissive dictionary so sanitisation keeps the columns the tests assert on.
const DICTIONARY = {
  locations: ['id', 'name', 'parent_id', 'updated_at'],
  categories: ['id', 'name', 'updated_at'],
  items: [
    'id',
    'name',
    'parent_id',
    'location_id',
    'tracking_mode',
    'gross_capacity',
    'current_net_value',
    'updated_at',
  ],
  item_aliases: ['id', 'item_id', 'alias', 'updated_at'],
  capabilities: ['id', 'item_id', 'key', 'updated_at'],
  contacts: ['id', 'name', 'updated_at'],
  checkouts: [
    'id',
    'item_id',
    'contact_id',
    'project_id',
    'location_id',
    'source_location_id',
    'checked_out_at',
    'returned_at',
    'updated_at',
  ],
  asset_bookings: [
    'id',
    'item_id',
    'contact_id',
    'start_date',
    'end_date',
    'cancelled_at',
    'converted_checkout_id',
    'created_at',
    'updated_at',
  ],
  field_defs: ['id', 'name', 'field_type', 'updated_at'],
  category_fields: ['id', 'category_id', 'def_id', 'updated_at'],
  location_field_values: ['id', 'location_id', 'def_id', 'value', 'is_inheritable', 'updated_at'],
  item_field_values: ['id', 'item_id', 'def_id', 'value', 'mode', 'updated_at'],
  kit_components: ['id', 'kit_item_id', 'component_item_id', 'quantity', 'sort', 'created_at', 'updated_at'],
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
  locationTags?: LocationTagEdge[];
  itemHistory?: SqlRow[];
}): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: partial.tables ?? {},
    tombstones: partial.tombstones ?? [],
    gaugeHistory: partial.gaugeHistory ?? [],
    itemTags: partial.itemTags ?? [],
    locationTags: partial.locationTags ?? [],
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

  it('issue #161: skips the no-op upsert when a tie is byte-identical to the local row', () => {
    // A tie (equal updated_at) resolves REMOTE_WINS, but the row is identical on both sides, so
    // applying would only re-fire the auto-stamp trigger and drive cross-device churn. Skip it.
    const row = { id: 'c1', name: 'Same', updated_at: 10 };
    const local = snapshot({ tables: { contacts: [{ ...row }] } });
    const remote = snapshot({ tables: { contacts: [{ ...row }] } });
    expect(reconcile(local, remote, opts).localUpserts).toHaveLength(0);
  });

  it('issue #161: a column only on the local row (excluded / schema-skew) does not defeat the skip', () => {
    // The apply's UPSERT only writes the sanitised remote columns, so a column the winning row
    // does not carry — e.g. a per-device sync-excluded column like `full_res_downgraded_at`, or
    // one an older peer's schema lacks — cannot change anything and must not force a re-upsert.
    const local = snapshot({
      tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 10, full_res_downgraded_at: 999 }] },
    });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 10 }] } });
    expect(reconcile(local, remote, opts).localUpserts).toHaveLength(0);
  });

  it('issue #161: still applies a tie whose content differs (a real concurrent edit)', () => {
    // Same updated_at, different content — REMOTE_WINS must actually write, so the two sides
    // converge on the remote's value rather than staying divergent.
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Local', updated_at: 10 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Remote', updated_at: 10 }] } });
    const plan = reconcile(local, remote, opts);
    expect(plan.localUpserts).toEqual([
      { table: 'contacts', row: { id: 'c1', name: 'Remote', updated_at: 10 } },
    ]);
  });

  it('issue #161: still applies a strictly-newer remote even when its content matches', () => {
    // Identical content but a newer stamp differs in updated_at, so this is not a no-op: adopting
    // the newer timestamp is a real write (NEW.updated_at ≠ OLD.updated_at, so no trigger churn).
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 10 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 20 }] } });
    expect(reconcile(local, remote, opts).localUpserts).toEqual([
      { table: 'contacts', row: { id: 'c1', name: 'Same', updated_at: 20 } },
    ]);
  });

  it('issue #161: an offset-induced tie of identical content still applies (frame shift is a real write)', () => {
    // Local 10, remote 20, +10 offset → the compared stamps tie (REMOTE_WINS), but the stored
    // local-frame value (10) differs from the server-frame value applied (20), so writing it is
    // not a no-op and must proceed — the shift itself is the change, and it cannot churn.
    const local = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 10 }] } });
    const remote = snapshot({ tables: { contacts: [{ id: 'c1', name: 'Same', updated_at: 20 }] } });
    expect(reconcile(local, remote, { ...opts, offset: 10 }).localUpserts).toEqual([
      { table: 'contacts', row: { id: 'c1', name: 'Same', updated_at: 20 } },
    ]);
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

  describe('issue #193 — serialised-loan cardinality', () => {
    const serialisedItem = {
      id: 'i1',
      name: 'Cordless drill',
      location_id: 'loc1',
      tracking_mode: 'SERIALISED',
      updated_at: 1,
    };
    const openLoan = (id: string, checkedOutAt: number, contactId: string) => ({
      id,
      item_id: 'i1',
      contact_id: contactId,
      checked_out_at: checkedOutAt,
      returned_at: null,
      updated_at: checkedOutAt,
    });

    it('closes the later of two open loans a merge downloaded onto one serialised item', () => {
      // Local kept the first loan; the peer's concurrent second loan arrives as new-on-remote.
      const local = snapshot({
        tables: { items: [serialisedItem], checkouts: [openLoan('ckA', 100, 'c1')] },
      });
      const remote = snapshot({ tables: { checkouts: [openLoan('ckB', 200, 'c2')] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.serialisedLoansClosed).toEqual([
        { itemId: 'i1', closedCheckoutId: 'ckB', keptCheckoutId: 'ckA' },
      ]);
      const ckB = plan.localUpserts.find((u) => u.table === 'checkouts' && u.row.id === 'ckB');
      expect(ckB?.row.returned_at).toBe(200); // its own checked_out_at → a zero-duration loan
      expect(ckB?.row.updated_at).toBe(201); // deterministic +1 bump
      // The survivor is left untouched (open), carried by the push half rather than an upsert.
      expect(plan.localUpserts.some((u) => u.table === 'checkouts' && u.row.id === 'ckA')).toBe(false);
    });

    it('closes a purely-local surplus loan when the peer holds the earlier one', () => {
      // The mirror side: this device made the *later* loan; the peer's earlier loan wins.
      const local = snapshot({
        tables: { items: [serialisedItem], checkouts: [openLoan('ckB', 200, 'c2')] },
      });
      const remote = snapshot({ tables: { checkouts: [openLoan('ckA', 100, 'c1')] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.serialisedLoansClosed).toEqual([
        { itemId: 'i1', closedCheckoutId: 'ckB', keptCheckoutId: 'ckA' },
      ]);
      // ckB was local-only, so a fresh upsert is emitted to close it.
      const ckB = plan.localUpserts.find((u) => u.table === 'checkouts' && u.row.id === 'ckB');
      expect(ckB?.row.returned_at).toBe(200);
      // The downloaded survivor stays open.
      const ckA = plan.localUpserts.find((u) => u.table === 'checkouts' && u.row.id === 'ckA');
      expect(ckA?.row.returned_at ?? null).toBeNull();
    });

    it('breaks a checked_out_at tie by the smaller id, so both devices agree', () => {
      const local = snapshot({
        tables: { items: [serialisedItem], checkouts: [openLoan('ckA', 100, 'c1')] },
      });
      const remote = snapshot({ tables: { checkouts: [openLoan('ckB', 100, 'c2')] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.serialisedLoansClosed).toEqual([
        { itemId: 'i1', closedCheckoutId: 'ckB', keptCheckoutId: 'ckA' },
      ]);
    });

    it('leaves multiple open loans on a DISCRETE item alone (legitimately out to several)', () => {
      const local = snapshot({
        tables: {
          items: [{ ...serialisedItem, tracking_mode: 'DISCRETE' }],
          checkouts: [openLoan('ckA', 100, 'c1')],
        },
      });
      const remote = snapshot({ tables: { checkouts: [openLoan('ckB', 200, 'c2')] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.serialisedLoansClosed).toEqual([]);
      const ckB = plan.localUpserts.find((u) => u.table === 'checkouts' && u.row.id === 'ckB');
      expect(ckB?.row.returned_at ?? null).toBeNull(); // downloaded unchanged, still open
    });

    it('does not touch a serialised item with only one open loan', () => {
      const returnedLoan = { ...openLoan('ckOld', 50, 'c0'), returned_at: 60 };
      const local = snapshot({
        tables: { items: [serialisedItem], checkouts: [openLoan('ckA', 100, 'c1')] },
      });
      const remote = snapshot({ tables: { checkouts: [returnedLoan] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.serialisedLoansClosed).toEqual([]);
    });
  });

  describe('issue #194 — asset-booking double-booking', () => {
    const bookableItem = {
      id: 'i1',
      name: 'Laser cutter',
      location_id: 'loc1',
      tracking_mode: 'SERIALISED',
      updated_at: 1,
    };
    const booking = (id: string, start: number, end: number, createdAt: number): SqlRow => ({
      id,
      item_id: 'i1',
      contact_id: null,
      start_date: start,
      end_date: end,
      note: null,
      cancelled_at: null,
      converted_checkout_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    it('cancels the later-created of two overlapping bookings a merge downloaded', () => {
      // Local reserved first (created_at 100); the peer's overlapping booking arrives as new-on-remote.
      const local = snapshot({
        tables: { items: [bookableItem], asset_bookings: [booking('bkA', 10, 30, 100)] },
      });
      const remote = snapshot({ tables: { asset_bookings: [booking('bkB', 20, 40, 200)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.bookingsCancelled).toEqual([
        { itemId: 'i1', cancelledBookingId: 'bkB', keptBookingId: 'bkA' },
      ]);
      const bkB = plan.localUpserts.find((u) => u.table === 'asset_bookings' && u.row.id === 'bkB');
      expect(bkB?.row.cancelled_at).toBe(200); // its own created_at → deterministic + frame-stable
      expect(bkB?.row.updated_at).toBe(201); // deterministic +1 bump
      // The survivor is left untouched (active), carried by the push half rather than an upsert.
      expect(plan.localUpserts.some((u) => u.table === 'asset_bookings' && u.row.id === 'bkA')).toBe(false);
    });

    it('cancels a purely-local surplus booking when the peer holds the earlier one', () => {
      // The mirror side: this device made the *later* booking; the peer's earlier one wins.
      const local = snapshot({
        tables: { items: [bookableItem], asset_bookings: [booking('bkB', 20, 40, 200)] },
      });
      const remote = snapshot({ tables: { asset_bookings: [booking('bkA', 10, 30, 100)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.bookingsCancelled).toEqual([
        { itemId: 'i1', cancelledBookingId: 'bkB', keptBookingId: 'bkA' },
      ]);
      // bkB was local-only, so a fresh upsert is emitted to cancel it.
      const bkB = plan.localUpserts.find((u) => u.table === 'asset_bookings' && u.row.id === 'bkB');
      expect(bkB?.row.cancelled_at).toBe(200);
      // The downloaded survivor stays active.
      const bkA = plan.localUpserts.find((u) => u.table === 'asset_bookings' && u.row.id === 'bkA');
      expect(bkA?.row.cancelled_at ?? null).toBeNull();
    });

    it('breaks a created_at tie by the smaller id, so both devices agree', () => {
      const local = snapshot({
        tables: { items: [bookableItem], asset_bookings: [booking('bkA', 10, 30, 100)] },
      });
      const remote = snapshot({ tables: { asset_bookings: [booking('bkB', 20, 40, 100)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.bookingsCancelled).toEqual([
        { itemId: 'i1', cancelledBookingId: 'bkB', keptBookingId: 'bkA' },
      ]);
    });

    it('leaves two non-overlapping bookings of the same asset alone', () => {
      const local = snapshot({
        tables: { items: [bookableItem], asset_bookings: [booking('bkA', 10, 12, 100)] },
      });
      const remote = snapshot({ tables: { asset_bookings: [booking('bkB', 20, 22, 200)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.bookingsCancelled).toEqual([]);
      const bkB = plan.localUpserts.find((u) => u.table === 'asset_bookings' && u.row.id === 'bkB');
      expect(bkB?.row.cancelled_at ?? null).toBeNull(); // downloaded unchanged, still active
    });

    it('ignores an already-cancelled or converted booking when detecting overlaps', () => {
      const cancelled = { ...booking('bkOld', 5, 40, 50), cancelled_at: 55 };
      const local = snapshot({
        tables: { items: [bookableItem], asset_bookings: [booking('bkA', 10, 30, 100)] },
      });
      const remote = snapshot({ tables: { asset_bookings: [cancelled] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.bookingsCancelled).toEqual([]);
    });
  });

  describe('issue #539 — kit containment cycle closed by a merge', () => {
    const kitItem = (id: string): SqlRow => ({
      id,
      name: id,
      location_id: 'loc1',
      tracking_mode: 'DISCRETE',
      updated_at: 1,
    });
    const edge = (id: string, kitId: string, componentId: string, createdAt: number): SqlRow => ({
      id,
      kit_item_id: kitId,
      component_item_id: componentId,
      quantity: 1,
      sort: 0,
      created_at: createdAt,
      updated_at: createdAt,
    });

    it('removes the later link of a two-edge loop and tombstones it deterministically', () => {
      // Local put Y inside X first (created_at 100); the peer's X-inside-Y edge arrives as new.
      const local = snapshot({
        tables: { items: [kitItem('X'), kitItem('Y')], kit_components: [edge('kcA', 'X', 'Y', 100)] },
      });
      const remote = snapshot({ tables: { kit_components: [edge('kcB', 'Y', 'X', 200)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.kitLinksBroken).toEqual([{ edgeId: 'kcB', kitItemId: 'Y', componentItemId: 'X' }]);
      // The incoming edge is not written at all, and its removal travels as a tombstone.
      expect(plan.localUpserts.some((u) => u.table === 'kit_components' && u.row.id === 'kcB')).toBe(false);
      expect(plan.localDeletes).toContainEqual({
        tableName: 'kit_components',
        id: 'kcB',
        deletedAt: 201, // its own updated_at + 1 — deterministic and frame-invariant
      });
      // The older link stands, carried by the push half rather than an upsert.
      expect(plan.localUpserts.some((u) => u.table === 'kit_components' && u.row.id === 'kcA')).toBe(false);
    });

    it('removes a purely-local later link when the peer holds the earlier one', () => {
      // The mirror side: this device made the later nesting move, so its own edge is the one to go.
      const local = snapshot({
        tables: { items: [kitItem('X'), kitItem('Y')], kit_components: [edge('kcB', 'Y', 'X', 200)] },
      });
      const remote = snapshot({ tables: { kit_components: [edge('kcA', 'X', 'Y', 100)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.kitLinksBroken).toEqual([{ edgeId: 'kcB', kitItemId: 'Y', componentItemId: 'X' }]);
      expect(plan.localDeletes).toContainEqual({
        tableName: 'kit_components',
        id: 'kcB',
        deletedAt: 201,
      });
      // The peer's earlier edge is downloaded and kept.
      expect(plan.localUpserts.some((u) => u.table === 'kit_components' && u.row.id === 'kcA')).toBe(true);
    });

    it('breaks a created_at tie by the smaller id, so both devices agree', () => {
      const local = snapshot({
        tables: { items: [kitItem('X'), kitItem('Y')], kit_components: [edge('kcA', 'X', 'Y', 100)] },
      });
      const remote = snapshot({ tables: { kit_components: [edge('kcB', 'Y', 'X', 100)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.kitLinksBroken).toEqual([{ edgeId: 'kcB', kitItemId: 'Y', componentItemId: 'X' }]);
    });

    it('removes only the newest link of a three-kit loop', () => {
      const local = snapshot({
        tables: {
          items: [kitItem('X'), kitItem('Y'), kitItem('Z')],
          kit_components: [edge('kcA', 'X', 'Y', 100), edge('kcB', 'Y', 'Z', 150)],
        },
      });
      const remote = snapshot({ tables: { kit_components: [edge('kcC', 'Z', 'X', 200)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.kitLinksBroken).toEqual([{ edgeId: 'kcC', kitItemId: 'Z', componentItemId: 'X' }]);
      expect(plan.localDeletes.some((d) => d.tableName === 'kit_components' && d.id === 'kcB')).toBe(false);
    });

    it('leaves a merged graph that only shares a component alone (a diamond is not a loop)', () => {
      // X contains Y and Z locally; the peer adds Z as a component of Y — legal, and no loop.
      const local = snapshot({
        tables: {
          items: [kitItem('X'), kitItem('Y'), kitItem('Z')],
          kit_components: [edge('kcA', 'X', 'Y', 100), edge('kcB', 'X', 'Z', 110)],
        },
      });
      const remote = snapshot({ tables: { kit_components: [edge('kcC', 'Y', 'Z', 200)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.kitLinksBroken).toEqual([]);
      expect(plan.localDeletes.some((d) => d.tableName === 'kit_components')).toBe(false);
      expect(plan.localUpserts.some((u) => u.table === 'kit_components' && u.row.id === 'kcC')).toBe(true);
    });

    it('counts one removal when the loop-closing link is a natural-key duplicate', () => {
      // Both devices added X → Y offline, so §7.5 retires one of the two ids for the shared
      // `(kit_item_id, component_item_id)` key. Only one link was ever made, so only one is
      // reported and tombstoned here — the retired twin is the collision pass's to delete.
      const local = snapshot({
        tables: {
          items: [kitItem('X'), kitItem('Y')],
          kit_components: [edge('kcB', 'Y', 'X', 100), edge('kcDup1', 'X', 'Y', 200)],
        },
      });
      const remote = snapshot({ tables: { kit_components: [edge('kcDup2', 'X', 'Y', 210)] } });
      const plan = reconcile(local, remote, opts);

      expect(plan.collisions.filter((c) => c.table === 'kit_components')).toHaveLength(1);
      expect(plan.kitLinksBroken).toHaveLength(1);
      expect(plan.kitLinksBroken[0]).toMatchObject({ kitItemId: 'X', componentItemId: 'Y' });
      // The retired id is not tombstoned twice — the collision verdict already deletes it.
      const retired = plan.collisions.find((c) => c.table === 'kit_components')!.loserId;
      expect(plan.localDeletes.some((d) => d.id === retired)).toBe(false);
    });

    it('ignores a loop edge whose item the merge deletes, since it goes with the item', () => {
      // The peer deleted kit Y; its edges cascade away, so nothing is left to break.
      const local = snapshot({
        tables: {
          items: [kitItem('X'), kitItem('Y')],
          kit_components: [edge('kcA', 'X', 'Y', 100), edge('kcB', 'Y', 'X', 200)],
        },
      });
      const remote = snapshot({ tombstones: [{ tableName: 'items', id: 'Y', deletedAt: 500 }] });
      const plan = reconcile(local, remote, opts);

      expect(plan.kitLinksBroken).toEqual([]);
      expect(plan.localDeletes.some((d) => d.tableName === 'kit_components')).toBe(false);
    });
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

  it('§7.5.3 rejects an item variant-parent move that would create a cycle (issue #190)', () => {
    // Local: item Y is a variant of X. Remote wants to make X a variant of Y → cycle.
    // Left unguarded the merge would converge to X→Y→X, and the recursive ancestor walk
    // that guards the next variant attach/detach would then never terminate.
    const local = snapshot({
      tables: {
        items: [
          { id: 'itemX', name: 'X', parent_id: null, location_id: UNASSIGNED_LOCATION_ID, updated_at: 1 },
          {
            id: 'itemY',
            name: 'Y',
            parent_id: 'itemX',
            location_id: UNASSIGNED_LOCATION_ID,
            updated_at: 1,
          },
        ],
      },
    });
    const remote = snapshot({
      tables: {
        items: [
          { id: 'itemX', name: 'X', parent_id: 'itemY', location_id: UNASSIGNED_LOCATION_ID, updated_at: 99 },
        ],
      },
    });
    const plan = reconcile(local, remote, opts);
    expect(plan.rejectedCycles).toContain('itemX');
    expect(plan.localUpserts.some((u) => u.table === 'items' && u.row.id === 'itemX')).toBe(false);
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

  it('§7.3 Delta-CRDT keeps the LWW value when a side’s gauge ledger was emptied', () => {
    // The local device cleared or pruned its ledger: the row still says 400 of 1000, but the
    // deltas that explain it are gone. Replaying what is left would reconstruct `1000 + 0` and
    // report a nearly-empty bottle as full — on both devices, permanently.
    const localItems = [
      {
        id: 'spool',
        name: 'PLA',
        location_id: UNASSIGNED_LOCATION_ID,
        tracking_mode: 'CONSUMABLE_GAUGE',
        gross_capacity: 1000,
        current_net_value: 400,
        updated_at: 10,
      },
    ];
    const local = snapshot({ tables: { items: localItems }, gaugeHistory: [] });
    const remote = snapshot({
      tables: { items: [{ ...localItems[0]!, current_net_value: 400, updated_at: 20 }] },
      gaugeHistory: [{ id: 'hA', itemId: 'spool', netValueDelta: -600, createdAt: 1 }],
    });
    expect(reconcile(local, remote, opts).gaugeResolutions).toEqual([]);
  });

  it('§7.3 Delta-CRDT tolerates float drift in proportion to the gauge’s own capacity', () => {
    // A fine-grained capacity (10 kg in milligrams) with thousands of fractional movements
    // accumulates a running-sum error on the order of n × ulp(gross) — which is drift, not a
    // missing entry. A fixed absolute tolerance would read it as a broken ledger and switch the
    // CRDT off for the item permanently.
    const gross = 1e7;
    const drift = 5e-7 * gross; // millions of times an absolute 1e-6, half a millionth of capacity
    const gauge = {
      id: 'vat',
      name: 'Resin',
      location_id: UNASSIGNED_LOCATION_ID,
      tracking_mode: 'CONSUMABLE_GAUGE',
      gross_capacity: gross,
      updated_at: 10,
    };
    const local = snapshot({
      tables: { items: [{ ...gauge, current_net_value: gross - 100 + drift }] },
      gaugeHistory: [{ id: 'hA', itemId: 'vat', netValueDelta: -100, createdAt: 1 }],
    });
    const remote = snapshot({
      tables: { items: [{ ...gauge, current_net_value: gross - 40 - drift, updated_at: 20 }] },
      gaugeHistory: [{ id: 'hB', itemId: 'vat', netValueDelta: -40, createdAt: 2 }],
    });
    // Both usages still survive the merge: 1e7 − 100 − 40.
    expect(reconcile(local, remote, opts).gaugeResolutions).toEqual([
      { itemId: 'vat', netValue: gross - 140 },
    ]);
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
      // Remote row is upserted; the local row is retired ahead of it so the UNIQUE text is
      // free by the time the INSERT runs (issue #187 moved this onto the shared channel).
      expect(plan.localUpserts.some((u) => u.row.id === 'remoteAl')).toBe(true);
      expect(plan.collisions).toContainEqual({
        table: 'item_aliases',
        loserId: 'localAl',
        winnerId: 'remoteAl',
        deletedAt: 20,
      });
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

    describe('issue #620 — a per-item clear survives the union', () => {
      /** The entry a clear leaves behind, at `at`. */
      const clearedAt = (at: number, id = `cleared-${at}`) => ({
        id,
        item_id: 'i1',
        action: 'HISTORY_CLEARED',
        created_at: at,
      });

      it('refuses to re-import the entries a local clear removed', () => {
        // This device cleared at 200; the peer still holds the entries from before it.
        const local = snapshot({ tables: { items: [item] }, itemHistory: [clearedAt(200)] });
        const remote = snapshot({
          tables: { items: [item] },
          itemHistory: [
            { id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 100 },
            { id: 'h2', item_id: 'i1', action: 'ADJUSTED', created_at: 300 },
          ],
        });
        const plan = reconcile(local, remote, opts);
        // Only the entry recorded *after* the clear comes across.
        expect(plan.historyInserts.map((r) => r.id)).toEqual(['h2']);
        // Nothing local to remove — this device already cleared.
        expect(plan.historyClears).toHaveLength(0);
      });

      it('adopts a peer’s clear, deleting the entries this device still holds', () => {
        const local = snapshot({
          tables: { items: [item] },
          itemHistory: [
            { id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 100 },
            { id: 'h2', item_id: 'i1', action: 'ADJUSTED', created_at: 300 },
          ],
        });
        const remote = snapshot({ tables: { items: [item] }, itemHistory: [clearedAt(200)] });
        const plan = reconcile(local, remote, opts);
        // The marker itself unions in, and everything before it goes.
        expect(plan.historyInserts.map((r) => r.id)).toEqual(['cleared-200']);
        expect(plan.historyClears).toEqual([{ itemId: 'i1', before: 200 }]);
      });

      it('takes the newest clear when both devices cleared, converging on one marker', () => {
        const local = snapshot({ tables: { items: [item] }, itemHistory: [clearedAt(200, 'local')] });
        const remote = snapshot({ tables: { items: [item] }, itemHistory: [clearedAt(500, 'remote')] });
        const plan = reconcile(local, remote, opts);
        expect(plan.historyInserts.map((r) => r.id)).toEqual(['remote']);
        // The earlier marker is itself older than the newest clear, so it goes too.
        expect(plan.historyClears).toEqual([{ itemId: 'i1', before: 500 }]);
      });

      it('scopes a clear to its own item', () => {
        const other = { ...item, id: 'i2' };
        const local = snapshot({
          tables: { items: [item, other] },
          itemHistory: [{ id: 'h1', item_id: 'i2', action: 'CREATED', created_at: 100 }],
        });
        const remote = snapshot({ tables: { items: [item, other] }, itemHistory: [clearedAt(200)] });
        const plan = reconcile(local, remote, opts);
        expect(plan.historyClears).toHaveLength(0);
      });

      it('emits nothing when the two devices already agree', () => {
        const cleared = clearedAt(200);
        const local = snapshot({ tables: { items: [item] }, itemHistory: [cleared] });
        const remote = snapshot({ tables: { items: [item] }, itemHistory: [cleared] });
        const plan = reconcile(local, remote, opts);
        expect(plan.historyInserts).toHaveLength(0);
        expect(plan.historyClears).toHaveLength(0);
      });

      it('skips a clear for an item that will not survive the merge', () => {
        const local = snapshot({
          tables: { items: [item] },
          itemHistory: [{ id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 100 }],
        });
        const remote = snapshot({
          tombstones: [{ tableName: 'items', id: 'i1', deletedAt: 50 }],
          itemHistory: [clearedAt(200)],
        });
        const plan = reconcile(local, remote, opts);
        expect(plan.historyClears).toHaveLength(0);
      });
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

  describe('issue #84 — M:N membership (location_tags, tombstone-wins union)', () => {
    const location = { id: 'l1', name: 'Van', updated_at: 1 };
    const tag = { id: 't1', name: 'mobile', updated_at: 1 };
    const bothSides = { tables: { locations: [location], tags: [tag] } };

    it('adds a remote-only location edge when both endpoints survive', () => {
      const local = snapshot(bothSides);
      const remote = snapshot({ ...bothSides, locationTags: [{ locationId: 'l1', tagId: 't1' }] });
      const plan = reconcile(local, remote, opts);
      expect(plan.locationTagUpserts).toEqual([{ locationId: 'l1', tagId: 't1' }]);
      expect(plan.locationTagDeletes).toHaveLength(0);
    });

    it('does not add a remote edge whose tag will not exist locally (FK-safe)', () => {
      const local = snapshot({ tables: { locations: [location] } }); // no tags
      const remote = snapshot({
        tables: { locations: [location] },
        locationTags: [{ locationId: 'l1', tagId: 'ghost' }],
      });
      expect(reconcile(local, remote, opts).locationTagUpserts).toHaveLength(0);
    });

    it('a peer tombstone removes a location edge we still hold', () => {
      const local = snapshot({ ...bothSides, locationTags: [{ locationId: 'l1', tagId: 't1' }] });
      const remote = snapshot({
        ...bothSides,
        tombstones: [{ tableName: 'location_tags', id: 'l1|t1', deletedAt: 42 }],
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.locationTagDeletes).toEqual([{ locationId: 'l1', tagId: 't1', deletedAt: 42 }]);
      expect(plan.locationTagUpserts).toHaveLength(0);
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

    it('drops a remote checkout whose project borrower was deleted on the peer (issue #404)', () => {
      // The project arm of the tagged-union borrower, and the exact twin of the contact case
      // above: `checkouts.project_id` is ON DELETE CASCADE, so the loan is meant to die with
      // the project. Nulling it instead is not available — the XOR CHECK forbids a checkout
      // with no borrower — so the upsert must be dropped or the whole merge aborts.
      const local = snapshot({
        tables: { projects: [{ id: 'p1', name: 'Henderson job', updated_at: 1 }] },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'projects', id: 'p1', deletedAt: 99 }],
        tables: { checkouts: [{ id: 'co1', item_id: 'i1', project_id: 'p1', updated_at: 5 }] },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.tableName === 'projects' && d.id === 'p1')).toBe(true);
      expect(plan.localUpserts.some((u) => u.table === 'checkouts')).toBe(false);
    });

    it('drops a remote checkout whose location borrower was deleted on the peer (issue #404)', () => {
      // The location arm. Distinct from `source_location_id` (the provenance, nullable), which
      // the next test pins: the borrower location cascades, the lend-from pointer clears.
      const local = snapshot({
        tables: { locations: [{ id: 'l1', name: 'Van', updated_at: 1 }] },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'locations', id: 'l1', deletedAt: 99 }],
        tables: { checkouts: [{ id: 'co1', item_id: 'i1', location_id: 'l1', updated_at: 5 }] },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.tableName === 'locations' && d.id === 'l1')).toBe(true);
      expect(plan.localUpserts.some((u) => u.table === 'checkouts')).toBe(false);
    });

    it('clears only the lend-from pointer when the removed location is not the borrower', () => {
      const local = snapshot({
        tables: {
          locations: [{ id: 'l1', name: 'Van', updated_at: 1 }],
          contacts: [{ id: 'c1', name: 'Alex', updated_at: 1 }],
        },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'locations', id: 'l1', deletedAt: 99 }],
        tables: {
          contacts: [{ id: 'c1', name: 'Alex', updated_at: 1 }],
          checkouts: [
            { id: 'co1', item_id: 'i1', contact_id: 'c1', source_location_id: 'l1', updated_at: 5 },
          ],
        },
      });
      const plan = reconcile(local, remote, opts);
      const checkout = plan.localUpserts.find((u) => u.table === 'checkouts');
      expect(checkout).toBeDefined();
      expect(checkout!.row.source_location_id).toBeNull(); // loan kept, provenance cleared
    });

    it('keeps a checkout whose project borrower survives the merge', () => {
      const local = snapshot({ tables: { projects: [{ id: 'p1', name: 'Henderson job', updated_at: 1 }] } });
      const remote = snapshot({
        tables: {
          projects: [{ id: 'p1', name: 'Henderson job', updated_at: 1 }],
          checkouts: [{ id: 'co1', item_id: 'i1', project_id: 'p1', updated_at: 5 }],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'checkouts' && u.row.id === 'co1')).toBe(true);
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

    it('drops a category_field when its category was removed', () => {
      // A category delete cascades its category_fields, which record no tombstone of their
      // own (§7.2). The peer never saw the delete and still offers the field → the deleting
      // device must not re-insert it.
      const local = snapshot({
        tables: {
          categories: [{ id: 'cat1', name: 'Resistors', updated_at: 1 }],
          field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }],
          category_fields: [{ id: 'f1', category_id: 'cat1', def_id: 'd1', updated_at: 1 }],
        },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'categories', id: 'cat1', deletedAt: 99 }],
        tables: {
          field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }],
          category_fields: [{ id: 'f1', category_id: 'cat1', def_id: 'd1', updated_at: 1 }],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.tableName === 'categories' && d.id === 'cat1')).toBe(true);
      expect(plan.localUpserts.some((u) => u.table === 'category_fields')).toBe(false);
    });

    it('keeps an item_field_value when only its category was removed (issue #97)', () => {
      // Values hang off the *definition*, not off a category's use of it, so deleting a
      // category no longer destroys what items stored for that field. The value survives
      // and reappears if the item is recategorised into another category using the def.
      const local = snapshot({
        tables: {
          categories: [{ id: 'cat1', name: 'Resistors', updated_at: 1 }],
          field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }],
          category_fields: [{ id: 'f1', category_id: 'cat1', def_id: 'd1', updated_at: 1 }],
        },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'categories', id: 'cat1', deletedAt: 99 }],
        tables: {
          field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }],
          item_field_values: [
            { id: 'v1', item_id: 'i1', def_id: 'd1', value: '1%', mode: 'literal', updated_at: 5 },
          ],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'item_field_values' && u.row.id === 'v1')).toBe(true);
    });

    it('drops an item_field_value when its field definition was removed', () => {
      // Deleting the definition itself *does* cascade every value referencing it, so a peer
      // that never saw the delete must not resurrect one.
      const local = snapshot({
        tables: { field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }] },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'field_defs', id: 'd1', deletedAt: 99 }],
        tables: {
          field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }],
          item_field_values: [
            { id: 'v1', item_id: 'i1', def_id: 'd1', value: '1%', mode: 'literal', updated_at: 5 },
          ],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localDeletes.some((d) => d.tableName === 'field_defs' && d.id === 'd1')).toBe(true);
      expect(plan.localUpserts.some((u) => u.table === 'item_field_values')).toBe(false);
    });

    it('drops a location_field_value when its definition was removed (issue #97)', () => {
      const local = snapshot({
        tables: { field_defs: [{ id: 'd1', name: 'Maker', field_type: 'TEXT', updated_at: 1 }] },
      });
      const remote = snapshot({
        tombstones: [{ tableName: 'field_defs', id: 'd1', deletedAt: 99 }],
        tables: {
          field_defs: [{ id: 'd1', name: 'Maker', field_type: 'TEXT', updated_at: 1 }],
          location_field_values: [
            {
              id: 'lv1',
              location_id: 'loc1',
              def_id: 'd1',
              value: 'Ryobi',
              is_inheritable: 1,
              updated_at: 5,
            },
          ],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'location_field_values')).toBe(false);
    });

    it('keeps an item_field_value when its definition survives', () => {
      const local = snapshot({
        tables: { field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }] },
      });
      const remote = snapshot({
        tables: {
          field_defs: [{ id: 'd1', name: 'tolerance', field_type: 'TEXT', updated_at: 1 }],
          item_field_values: [
            { id: 'v1', item_id: 'i1', def_id: 'd1', value: '1%', mode: 'literal', updated_at: 5 },
          ],
        },
      });
      const plan = reconcile(local, remote, opts);
      expect(plan.localUpserts.some((u) => u.table === 'item_field_values' && u.row.id === 'v1')).toBe(true);
    });
  });

  describe('actor attribution on inbound ledger rows (issue #79)', () => {
    const DICT_WITH_ACTOR = {
      ...DICTIONARY,
      users: ['id', 'username', 'display_name', 'kind', 'role_id', 'updated_at'],
      item_history: [...DICTIONARY.item_history, 'actor_user_id'],
    };
    const withActor = { offset: 0, dictionary: DICT_WITH_ACTOR };
    const item = { id: 'i1', name: 'Drill', updated_at: 1 };

    function historyFrom(actor: string | undefined): SqlRow[] {
      const row: SqlRow = { id: 'h1', item_id: 'i1', action: 'CREATED', created_at: 5 };
      return [actor === undefined ? row : { ...row, actor_user_id: actor }];
    }

    it("preserves the peer's actor when that user survives the merge", () => {
      const sam = { id: 'u-sam', username: 'sam', display_name: 'Sam', kind: 'normal', updated_at: 1 };
      const local = snapshot({ tables: { items: [item], users: [sam] } });
      const remote = snapshot({ tables: { items: [item], users: [sam] }, itemHistory: historyFrom('u-sam') });

      const plan = reconcile(local, remote, withActor);

      expect(plan.historyInserts).toHaveLength(1);
      expect(plan.historyInserts[0].actor_user_id).toBe('u-sam');
    });

    it('preserves attribution to the built-in Admin, which is never in the synced user set', () => {
      // Admin is seeded identically on every device and excluded from the snapshot, so it
      // never appears in `tables.users`. Treating that as "unknown user" would silently
      // re-attribute every ordinary edit to System.
      const local = snapshot({ tables: { items: [item] } });
      const remote = snapshot({ tables: { items: [item] }, itemHistory: historyFrom(ADMIN_USER_ID) });

      const plan = reconcile(local, remote, withActor);

      expect(plan.historyInserts[0].actor_user_id).toBe(ADMIN_USER_ID);
    });

    it('re-attributes to System rather than dropping the entry when the author is unknown', () => {
      const local = snapshot({ tables: { items: [item] } });
      const remote = snapshot({ tables: { items: [item] }, itemHistory: historyFrom('u-ghost') });

      const plan = reconcile(local, remote, withActor);

      // Losing *who* did it is preferable to losing the record that it happened at all.
      expect(plan.historyInserts).toHaveLength(1);
      expect(plan.historyInserts[0].actor_user_id).toBe(SYSTEM_USER_ID);
    });

    it('leaves a row that carries no actor column for the schema default to fill', () => {
      const local = snapshot({ tables: { items: [item] } });
      const remote = snapshot({ tables: { items: [item] }, itemHistory: historyFrom(undefined) });

      const plan = reconcile(local, remote, withActor);

      expect(plan.historyInserts).toHaveLength(1);
      expect(plan.historyInserts[0].actor_user_id).toBeUndefined();
    });

    it('follows a re-keyed author when two devices invented the same username', () => {
      // Both devices minted a "sam" with different random ids; the newer row wins the
      // username and the loser is retired, so the ledger must follow the winner.
      const localSam = { id: 'u-local', username: 'sam', display_name: 'Sam', kind: 'normal', updated_at: 1 };
      const remoteSam = {
        id: 'u-remote',
        username: 'sam',
        display_name: 'Sam',
        kind: 'normal',
        updated_at: 9,
      };
      const local = snapshot({ tables: { items: [item], users: [localSam] } });
      const remote = snapshot({
        tables: { items: [item], users: [remoteSam] },
        itemHistory: historyFrom('u-local'),
      });

      const plan = reconcile(local, remote, withActor);

      expect(plan.historyInserts).toHaveLength(1);
      expect(plan.historyInserts[0].actor_user_id).toBe('u-remote');
    });
  });
});
