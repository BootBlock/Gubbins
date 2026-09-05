/**
 * Pure event-model tests (EI-1). No DB, no clock — synthetic ledger entries and item shapes.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityFeedEntry, Item } from '@/db/repositories/types';
import type { ItemSummaryDto } from '../api/dto.ts';
import {
  buildEvents,
  diffNewEntries,
  eventTypeForAction,
  EVENTS_TRUNCATED_TYPE,
  type EventCursor,
  type ResolvedEntry,
} from './model.ts';

/** A minimal synthetic ledger entry (only the fields the model reads). */
function entry(overrides: Partial<ActivityFeedEntry> & { id: string; createdAt: number }): ActivityFeedEntry {
  return {
    itemId: 'item-1',
    action: 'QUANTITY_CHANGE',
    quantityDelta: -1,
    netValueDelta: null,
    note: null,
    metadata: null,
    actorUserId: 'user-ada',
    actorDisplayName: 'Ada Okafor',
    itemName: 'Widget',
    itemIsActive: true,
    ...overrides,
  } as ActivityFeedEntry;
}

/** A minimal DISCRETE item stub — only the reorder-policy slice is read by the model. */
function discreteItem(quantity: number, reorderPoint: number | null = null): Item {
  return {
    trackingMode: 'DISCRETE',
    quantity,
    gauge: null,
    reorderPoint,
    reorderGaugePercent: null,
    reorderQty: null,
  } as unknown as Item;
}

const summary: ItemSummaryDto = {
  id: 'item-1',
  name: 'Widget',
  quantity: 3,
  locationId: 'loc-1',
  locationName: 'Shelf 2',
  categoryId: null,
  mpn: null,
  manufacturer: null,
  trackingMode: 'DISCRETE',
  isActive: true,
  isUnlimited: false,
};

function resolved(e: ActivityFeedEntry, item: Item | null): ResolvedEntry {
  return { entry: e, item, summary: item ? summary : null };
}

describe('eventTypeForAction', () => {
  it('maps known actions to stable dotted types', () => {
    expect(eventTypeForAction('CREATED')).toBe('item.created');
    expect(eventTypeForAction('QUANTITY_CHANGE')).toBe('stock.adjusted');
    expect(eventTypeForAction('CHECKED_OUT')).toBe('item.checked_out');
  });

  it('falls back to item.changed for an unknown (forward-compat) action', () => {
    expect(eventTypeForAction('SOME_FUTURE_ACTION')).toBe('item.changed');
  });
});

describe('diffNewEntries', () => {
  it('establishes a baseline and emits nothing on the first generation (no history replay)', () => {
    const recent = [entry({ id: 'b', createdAt: 200 }), entry({ id: 'a', createdAt: 100 })];
    const { newEntries, cursor, baseline } = diffNewEntries(null, recent);
    expect(baseline).toBe(true);
    expect(newEntries).toEqual([]);
    expect(cursor).toEqual({ seenIds: ['b', 'a'], backfillFloor: null });
  });

  it('returns rows whose ids were not in the previous window, oldest-first', () => {
    const previous: EventCursor = { seenIds: ['a'] };
    const recent = [
      entry({ id: 'c', createdAt: 300 }),
      entry({ id: 'b', createdAt: 200 }),
      entry({ id: 'a', createdAt: 100 }),
    ];
    const { newEntries, cursor, baseline } = diffNewEntries(previous, recent);
    expect(baseline).toBe(false);
    expect(newEntries.map((e) => e.id)).toEqual(['b', 'c']);
    expect(cursor).toEqual({ seenIds: ['c', 'b', 'a'], backfillFloor: null });
  });

  it('detects an out-of-order synced row whose timestamp predates the last-seen boundary', () => {
    // A row synced from another device carries its OWN earlier created_at (150) but a fresh id.
    const previous: EventCursor = { seenIds: ['b', 'a'] }; // last saw b@200, a@100
    const recent = [
      entry({ id: 'b', createdAt: 200 }),
      entry({ id: 'x', createdAt: 150 }), // new, but older than b — a watermark cursor would drop it
      entry({ id: 'a', createdAt: 100 }),
    ];
    const { newEntries } = diffNewEntries(previous, recent);
    expect(newEntries.map((e) => e.id)).toEqual(['x']);
  });

  it('does not re-emit rows already seen in the previous window', () => {
    const previous: EventCursor = { seenIds: ['a1', 'a2'] };
    const recent = [entry({ id: 'a2', createdAt: 100 }), entry({ id: 'a1', createdAt: 100 })];
    const { newEntries } = diffNewEntries(previous, recent);
    expect(newEntries).toEqual([]);
  });

  it('holds the previous seen-set when a generation brings no rows', () => {
    const previous: EventCursor = { seenIds: ['a'] };
    const { newEntries, cursor } = diffNewEntries(previous, []);
    expect(newEntries).toEqual([]);
    expect(cursor).toEqual({ seenIds: ['a'], backfillFloor: null });
  });
});

/**
 * The backfill floor (issue #642). The id set alone is bounded by the scan window, so anything
 * that *shortens* the window — a hard delete cascading an item's ledger away, a history prune, a
 * restored backup shorter than the live ledger — lets rows that were previously below the window
 * slide up into it, where an id diff reads them as new and re-announces months-old changes to
 * every webhook, SSE client and MQTT subscriber.
 */
describe('diffNewEntries backfill floor', () => {
  /** A full three-row window, newest-first, at 300 / 200 / 100. */
  const window3 = [
    entry({ id: 'r1', createdAt: 300 }),
    entry({ id: 'r2', createdAt: 200 }),
    entry({ id: 'r3', createdAt: 100 }),
  ];

  it('records the oldest row of the window as the floor when rows exist below it', () => {
    const { cursor } = diffNewEntries(null, window3, { windowFull: true });
    expect(cursor).toEqual({ seenIds: ['r1', 'r2', 'r3'], backfillFloor: 100 });
  });

  it('records no floor when the window holds the whole ledger', () => {
    const { cursor } = diffNewEntries(null, window3, { windowFull: false });
    expect(cursor.backfillFloor).toBeNull();
  });

  it('emits nothing for a generation that only deletes rows', () => {
    // The invariant this exists for. Baseline sees r1..r3 with r4@50 below the window; deleting r2
    // pulls r4 up into view, and its id has never been seen.
    const baseline = diffNewEntries(null, window3, { windowFull: true });
    const afterDelete = [
      entry({ id: 'r1', createdAt: 300 }),
      entry({ id: 'r3', createdAt: 100 }),
      entry({ id: 'r4', createdAt: 50 }),
    ];
    const { newEntries, cursor } = diffNewEntries(baseline.cursor, afterDelete, { windowFull: true });
    expect(newEntries).toEqual([]);
    // r4 is settled into the seen set all the same, so it is never reconsidered.
    expect(cursor).toEqual({ seenIds: ['r1', 'r3', 'r4'], backfillFloor: 50 });
  });

  it('emits nothing when a deleted item takes a whole run of ledger rows with it', () => {
    const baseline = diffNewEntries(null, window3, { windowFull: true });
    const afterDelete = [
      entry({ id: 'r4', createdAt: 50 }),
      entry({ id: 'r5', createdAt: 40 }),
      entry({ id: 'r6', createdAt: 30 }),
    ];
    expect(diffNewEntries(baseline.cursor, afterDelete, { windowFull: true }).newEntries).toEqual([]);
  });

  it('still emits a genuinely new row written in the same generation as a delete', () => {
    const baseline = diffNewEntries(null, window3, { windowFull: true });
    const mixed = [
      entry({ id: 'n1', createdAt: 400 }), // written now
      entry({ id: 'r1', createdAt: 300 }),
      entry({ id: 'r3', createdAt: 100 }), // r2 deleted
      entry({ id: 'r4', createdAt: 50 }), // backfilled from below
    ];
    const { newEntries } = diffNewEntries(baseline.cursor, mixed, { windowFull: true });
    expect(newEntries.map((e) => e.id)).toEqual(['n1']);
  });

  it('still emits an out-of-order synced row that sits inside the window', () => {
    // The case the id diff exists for, and the reason the floor sits at the *bottom* of the window
    // rather than being a high-water mark on the newest row: x@150 predates r1, but not the floor.
    const baseline = diffNewEntries(null, window3, { windowFull: true });
    const synced = [
      entry({ id: 'r1', createdAt: 300 }),
      entry({ id: 'r2', createdAt: 200 }),
      entry({ id: 'x', createdAt: 150 }),
    ];
    const { newEntries } = diffNewEntries(baseline.cursor, synced, { windowFull: true });
    expect(newEntries.map((e) => e.id)).toEqual(['x']);
  });

  it('suppresses nothing when the previous window held the whole ledger', () => {
    // No floor was recorded, so an older row synced from another device is still news.
    const baseline = diffNewEntries(null, window3, { windowFull: false });
    const synced = [...window3, entry({ id: 'x', createdAt: 20 })];
    const { newEntries } = diffNewEntries(baseline.cursor, synced, { windowFull: false });
    expect(newEntries.map((e) => e.id)).toEqual(['x']);
  });

  it('holds the floor through a generation that reads back an empty ledger', () => {
    const baseline = diffNewEntries(null, window3, { windowFull: true });
    const empty = diffNewEntries(baseline.cursor, []);
    expect(empty.cursor).toEqual({ seenIds: ['r1', 'r2', 'r3'], backfillFloor: 100 });
  });
});

describe('buildEvents', () => {
  it('maps a create to a single item.created event with the shaped payload', () => {
    const e = entry({ id: 'e1', createdAt: 1_000, action: 'CREATED', quantityDelta: 5, note: 'Added.' });
    const events = buildEvents([resolved(e, discreteItem(5))]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'e1',
      type: 'item.created',
      occurredAt: new Date(1_000).toISOString(),
      data: { itemId: 'item-1', action: 'CREATED', kind: 'created', label: 'Created', delta: '+5' },
    });
    expect(events[0]!.data.item).toEqual(summary);
  });

  it('names who made the change, id and display name (issue #774)', () => {
    // Two changes by two people were previously indistinguishable to a subscriber: the payload
    // carried what and when, and nothing that answered who.
    const e = entry({ id: 'e1', createdAt: 1_000, actorUserId: 'user-grace', actorDisplayName: 'Grace' });
    const [event] = buildEvents([resolved(e, discreteItem(5))]);
    expect(event!.data.actorUserId).toBe('user-grace');
    expect(event!.data.actorDisplayName).toBe('Grace');
  });

  it('adds a derived item.low_stock event when a stock movement leaves the item low', () => {
    const e = entry({ id: 'e2', createdAt: 2_000, action: 'QUANTITY_CHANGE', quantityDelta: -4 });
    const events = buildEvents([resolved(e, discreteItem(3, 5))]); // 3 <= the item's reorder point (5)
    expect(events.map((ev) => ev.type)).toEqual(['stock.adjusted', 'item.low_stock']);
    expect(events[1]!.id).toBe('e2:low_stock');
  });

  it('emits item.out_of_stock (not low_stock) when the item is fully depleted', () => {
    const e = entry({ id: 'e3', createdAt: 3_000, action: 'QUANTITY_CHANGE', quantityDelta: -3 });
    const events = buildEvents([resolved(e, discreteItem(0, 5))]); // depleted, with a reorder point set
    expect(events.map((ev) => ev.type)).toEqual(['stock.adjusted', 'item.out_of_stock']);
    expect(events[1]!.id).toBe('e3:out_of_stock');
  });

  it('emits item.out_of_stock when a movement depletes an item that has no reorder point', () => {
    // Out-of-stock is not opt-in: running to zero raises the event even with no reorder floor set
    // (the default configuration). Previously this was silently gated behind the low-stock check.
    const e = entry({ id: 'e3b', createdAt: 3_500, action: 'QUANTITY_CHANGE', quantityDelta: -1 });
    const events = buildEvents([resolved(e, discreteItem(0))]); // depleted, no reorder point
    expect(events.map((ev) => ev.type)).toEqual(['stock.adjusted', 'item.out_of_stock']);
    expect(events[1]!.id).toBe('e3b:out_of_stock');
  });

  it('emits no status event for a healthy stock level or a non-stock action', () => {
    const healthy = buildEvents([resolved(entry({ id: 'e4', createdAt: 4_000 }), discreteItem(50))]);
    expect(healthy.map((ev) => ev.type)).toEqual(['stock.adjusted']);

    const rename = entry({ id: 'e5', createdAt: 5_000, action: 'RENAMED', quantityDelta: null });
    const renamed = buildEvents([resolved(rename, discreteItem(1))]);
    expect(renamed.map((ev) => ev.type)).toEqual(['item.renamed']);
  });

  it('never raises a status event when the item could not be resolved', () => {
    const e = entry({ id: 'e6', createdAt: 6_000, action: 'QUANTITY_CHANGE' });
    const events = buildEvents([resolved(e, null)]);
    expect(events.map((ev) => ev.type)).toEqual(['stock.adjusted']);
    expect(events[0]!.data.item).toBeNull();
  });

  it('caps the fan-out and appends a truncation summary', () => {
    const many: ResolvedEntry[] = Array.from({ length: 10 }, (_, i) =>
      resolved(
        entry({ id: `m${i}`, createdAt: 7_000 + i, action: 'RENAMED', quantityDelta: null }),
        discreteItem(50),
      ),
    );
    const events = buildEvents(many, { fanOutCap: 4 });
    expect(events).toHaveLength(5); // 4 kept + 1 summary
    const last = events[events.length - 1]!;
    expect(last.type).toBe(EVENTS_TRUNCATED_TYPE);
    expect(last.data.label).toContain('6 more');
  });
});
