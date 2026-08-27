/**
 * Pure location event-model tests (issue #691). No DB, no clock — synthetic activity entries.
 */
import { describe, expect, it } from 'vitest';
import type { LocationHistoryEntry } from '@/db/repositories/types';
import {
  buildLocationEvents,
  diffNewLocationEntries,
  EVENTS_TRUNCATED_TYPE,
  isLocationEvent,
  type EventCursor,
} from './model.ts';

/** A minimal synthetic location activity entry (only the fields the model reads). */
function entry(overrides: Partial<LocationHistoryEntry> & { id: string }): LocationHistoryEntry {
  return {
    locationId: 'loc-1',
    locationName: 'Shelf B',
    action: 'RENAMED',
    note: 'Renamed from "Shelf A" to "Shelf B".',
    metadata: null,
    actorUserId: 'user-1',
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as LocationHistoryEntry;
}

describe('diffNewLocationEntries', () => {
  it('establishes a baseline and emits nothing on the first generation', () => {
    const result = diffNewLocationEntries(null, [entry({ id: 'a' })]);
    expect(result.baseline).toBe(true);
    expect(result.newEntries).toEqual([]);
    expect(result.locationSeenIds).toEqual(['a']);
  });

  it('baselines independently when an older cursor carries no location window', () => {
    // The shape a cursor persisted before this feature has: item ids, no location ids. Replaying
    // the whole location record as "new" would be a burst of events for changes made long ago.
    const older: EventCursor = { seenIds: ['h-1'] };
    const result = diffNewLocationEntries(older, [entry({ id: 'a' })]);
    expect(result.baseline).toBe(true);
    expect(result.newEntries).toEqual([]);
  });

  it('returns only unseen rows, oldest-first', () => {
    const previous: EventCursor = { seenIds: [], locationSeenIds: ['a'] };
    // `recent` arrives newest-first, exactly as the feed read returns it.
    const result = diffNewLocationEntries(previous, [
      entry({ id: 'c' }),
      entry({ id: 'b' }),
      entry({ id: 'a' }),
    ]);
    expect(result.newEntries.map((e) => e.id)).toEqual(['b', 'c']);
    expect(result.locationSeenIds).toEqual(['c', 'b', 'a']);
  });

  it('holds the previous window when the ledger reads back empty', () => {
    const previous: EventCursor = { seenIds: [], locationSeenIds: ['a'] };
    expect(diffNewLocationEntries(previous, []).locationSeenIds).toEqual(['a']);
  });

  it('does not replay rows that slide up into a window the ledger shrank under', () => {
    // The location twin of issue #642: a prune or a restored backup shortens the window, and the
    // rows that were below it are not news. The floor is the previous window's oldest row.
    const previous: EventCursor = {
      seenIds: [],
      locationSeenIds: ['a', 'b'],
      locationBackfillFloor: 200,
    };
    const result = diffNewLocationEntries(
      previous,
      [entry({ id: 'a', createdAt: 300 }), entry({ id: 'c', createdAt: 100 })],
      { windowFull: true },
    );
    expect(result.newEntries).toEqual([]);
    expect(result.locationSeenIds).toEqual(['a', 'c']);
    expect(result.locationBackfillFloor).toBe(100);
  });
});

describe('buildLocationEvents', () => {
  it('maps each action to its dotted type and shapes the payload', () => {
    const events = buildLocationEvents([
      entry({ id: 'a', action: 'CREATED' }),
      entry({ id: 'b', action: 'RE_PARENTED' }),
      entry({ id: 'c', action: 'DELETED' }),
    ]);

    expect(events.map((e) => e.type)).toEqual(['location.created', 'location.moved', 'location.removed']);
    expect(events[1]).toMatchObject({
      id: 'b',
      occurredAt: '2023-11-14T22:13:20.000Z',
      data: { locationId: 'loc-1', locationName: 'Shelf B', action: 'RE_PARENTED', label: 'Moved' },
    });
    // `location.removed` still names which location went — an automation keyed by location id
    // has nothing to act on otherwise, and it is the event most likely to be acted on.
    expect(events[2]!.data).toMatchObject({ locationId: 'loc-1', locationName: 'Shelf B' });
  });

  it('falls back to location.changed for an action a newer peer synced', () => {
    const [event] = buildLocationEvents([entry({ id: 'a', action: 'RECOLOURED' as never })]);
    expect(event!.type).toBe('location.changed');
    expect(event!.data.label).toBe('Recoloured');
  });

  it('blanks a whitespace-only note rather than publishing it', () => {
    const [event] = buildLocationEvents([entry({ id: 'a', note: '   ' })]);
    expect(event!.data.detail).toBeNull();
  });

  it('caps the fan-out and says how much it dropped', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `e-${i}` }));
    const events = buildLocationEvents(entries, { fanOutCap: 3 });

    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).map((e) => e.id)).toEqual(['e-0', 'e-1', 'e-2']);
    const summary = events[3]!;
    expect(summary.type).toBe(EVENTS_TRUNCATED_TYPE);
    expect(summary.id).toBe('e-2:truncated:2');
    expect(summary.data.label).toBe('2 more location changes not delivered');
  });
});

describe('isLocationEvent', () => {
  it('recognises a location event by its payload, including the truncation summary', () => {
    // The summary carries `events.truncated` — the one type that can arrive with either payload
    // shape — so a type-name test would misroute it into the item-shaped view.
    const events = buildLocationEvents([entry({ id: 'a' }), entry({ id: 'b' })], { fanOutCap: 1 });
    expect(events.map(isLocationEvent)).toEqual([true, true]);
  });

  it('does not claim an item event', () => {
    const itemShaped = {
      id: 'h-1',
      type: 'item.renamed',
      occurredAt: '2023-11-14T22:13:20.000Z',
      data: { itemId: 'item-1', itemName: 'Widget' },
    };
    expect(isLocationEvent(itemShaped as never)).toBe(false);
  });
});
