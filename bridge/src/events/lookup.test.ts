/**
 * A2 lookup-event tests — the READ-triggered `lookup.resolved` event.
 *
 * Covers the four things that make this event different from every other one: its exact wire
 * shape, its deterministic (non-ledger-derived) id, its debounce, and the fact that it is off
 * unless its own flag is set. All data here is SYNTHETIC (invented parts and locations).
 */
import { describe, expect, it } from 'vitest';
import {
  buildLookupEvent,
  createLookupObserver,
  lookupEventId,
  normaliseQuery,
  LOOKUP_RESOLVED_TYPE,
  type LookupEvent,
} from './lookup.ts';
import type { WhereIsMatch, WhereIsResult } from '../query.ts';

function match(over: Partial<WhereIsMatch> = {}): WhereIsMatch {
  return {
    id: 'item-m3-screw',
    name: 'M3 Screw',
    quantity: 12,
    locationId: 'loc-drawer-a',
    locationName: 'Drawer A',
    mpn: null,
    manufacturer: null,
    placements: [{ locationId: 'loc-drawer-a', locationName: 'Drawer A', quantity: 12 }],
    ...over,
  };
}

function result(over: Partial<WhereIsResult> = {}): WhereIsResult {
  return { query: 'M3 screws', matches: [match()], spoken: 'ignored', ...over };
}

/** A stub clock the tests advance by hand, so both the debounce and the id are deterministic. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('buildLookupEvent — the wire shape', () => {
  it('emits the exact documented contract', () => {
    const event = buildLookupEvent(
      result({
        matches: [
          match({
            placements: [
              { locationId: 'loc-drawer-a', locationName: 'Drawer A', quantity: 12 },
              { locationId: 'loc-bin-4', locationName: 'Bin 4', quantity: 3 },
            ],
          }),
        ],
      }),
      1_700_000_000_000,
      1_700_000_000_000,
    );

    expect(Object.keys(event).sort()).toEqual(['data', 'id', 'occurredAt', 'type']);
    expect(event.type).toBe('lookup.resolved');
    expect(event.type).toBe(LOOKUP_RESOLVED_TYPE);
    expect(event.id).toMatch(/^lookup:[0-9a-f]{16}:\d+$/);
    expect(event.occurredAt).toBe('2023-11-14T22:13:20.000Z');
    expect(event.data).toEqual({
      query: 'M3 screws',
      itemIds: ['item-m3-screw'],
      locationIds: ['loc-drawer-a', 'loc-bin-4'],
      matches: [
        {
          itemId: 'item-m3-screw',
          itemName: 'M3 Screw',
          placements: [
            { locationId: 'loc-drawer-a', locationName: 'Drawer A', quantity: 12 },
            { locationId: 'loc-bin-4', locationName: 'Bin 4', quantity: 3 },
          ],
        },
      ],
    });
  });

  it('flattens and de-duplicates the top-level id unions across matches, in match order', () => {
    const event = buildLookupEvent(
      result({
        matches: [
          match({
            id: 'item-a',
            placements: [
              { locationId: 'loc-bin-4', locationName: 'Bin 4', quantity: 1 },
              { locationId: 'loc-drawer-a', locationName: 'Drawer A', quantity: 2 },
            ],
          }),
          match({
            id: 'item-b',
            // Same location as item-a — the union must not repeat it.
            placements: [{ locationId: 'loc-drawer-a', locationName: 'Drawer A', quantity: 5 }],
          }),
        ],
      }),
      1,
      1,
    );

    expect(event.data.itemIds).toEqual(['item-a', 'item-b']);
    expect(event.data.locationIds).toEqual(['loc-bin-4', 'loc-drawer-a']);
  });

  it('emits empty unions for a lookup that found nothing', () => {
    const event = buildLookupEvent(result({ matches: [] }), 1, 1);
    expect(event.data.itemIds).toEqual([]);
    expect(event.data.locationIds).toEqual([]);
    expect(event.data.matches).toEqual([]);
  });

  it('carries the query verbatim, not the normalised form used for the id', () => {
    const event = buildLookupEvent(result({ query: 'M3 Screws' }), 1, 1);
    expect(event.data.query).toBe('M3 Screws');
  });
});

describe('lookupEventId — the deterministic, dedupe-friendly derivation', () => {
  it('is stable for the same answer in the same window', () => {
    const a = lookupEventId('M3 screws', ['item-a'], ['loc-1'], 1000);
    const b = lookupEventId('M3 screws', ['item-a'], ['loc-1'], 1000);
    expect(a).toBe(b);
  });

  it('ignores case and surrounding/collapsible whitespace in the query', () => {
    expect(normaliseQuery('  M3   Screws ')).toBe('m3 screws');
    expect(lookupEventId('  M3   Screws ', ['item-a'], ['loc-1'], 1000)).toBe(
      lookupEventId('m3 screws', ['item-a'], ['loc-1'], 1000),
    );
  });

  it('changes when the resolved answer changes, even for identical wording', () => {
    const base = lookupEventId('M3 screws', ['item-a'], ['loc-1'], 1000);
    expect(lookupEventId('M3 screws', ['item-b'], ['loc-1'], 1000)).not.toBe(base);
    expect(lookupEventId('M3 screws', ['item-a'], ['loc-2'], 1000)).not.toBe(base);
    expect(lookupEventId('M4 screws', ['item-a'], ['loc-1'], 1000)).not.toBe(base);
  });

  it('changes with the debounce window, so a later repeat is a distinct delivery', () => {
    expect(lookupEventId('M3 screws', ['item-a'], ['loc-1'], 1000)).not.toBe(
      lookupEventId('M3 screws', ['item-a'], ['loc-1'], 9000),
    );
  });

  it('is not confusable across the id-list boundaries', () => {
    // 'a,b' + '' must not hash the same as 'a' + 'b' — the separator is part of the payload.
    expect(lookupEventId('q', ['a', 'b'], [], 0)).not.toBe(lookupEventId('q', ['a'], ['b'], 0));
  });
});

describe('createLookupObserver — debounce', () => {
  function collector(): { events: LookupEvent[]; deliver: (e: LookupEvent) => void } {
    const events: LookupEvent[] = [];
    return { events, deliver: (e) => void events.push(e) };
  }

  it('emits nothing when the lookup matched nothing', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    // Nothing matched: there is no location for an automation to act on, and the Home Assistant
    // intent handler suppresses this same case — the two paths must not disagree.
    observer.onLookupResolved(result({ matches: [], query: 'flux capacitors' }));

    expect(c.events).toHaveLength(0);
  });

  it('does not let a matchless lookup consume the debounce window', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    // A miss must not open a window that then swallows the real answer moments later.
    observer.onLookupResolved(result({ matches: [] }));
    t.advance(10);
    observer.onLookupResolved(result());

    expect(c.events).toHaveLength(1);
  });

  it('emits once for repeated equivalent lookups inside the window', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    observer.onLookupResolved(result());
    t.advance(500);
    observer.onLookupResolved(result());
    t.advance(500);
    observer.onLookupResolved(result({ query: '  m3   SCREWS ' })); // a rephrase that normalises the same

    expect(c.events).toHaveLength(1);
  });

  it('emits again once the window has closed', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    observer.onLookupResolved(result());
    t.advance(3000);
    observer.onLookupResolved(result());

    expect(c.events).toHaveLength(2);
    expect(c.events[0]!.id).not.toBe(c.events[1]!.id);
  });

  it('does not let a stream of retries keep re-arming the window', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    // A retry every second for four seconds: the window is anchored at the first emission, so the
    // one at t+3000 emits regardless of the retries in between.
    for (let i = 0; i < 5; i += 1) {
      observer.onLookupResolved(result());
      t.advance(1000);
    }
    expect(c.events).toHaveLength(2);
  });

  it('emits immediately for a genuinely different query', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    observer.onLookupResolved(result());
    observer.onLookupResolved(result({ query: 'M4 screws' }));

    expect(c.events).toHaveLength(2);
    expect(c.events.map((e) => e.data.query)).toEqual(['M3 screws', 'M4 screws']);
  });

  it('emits immediately when the same wording now resolves somewhere else', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    observer.onLookupResolved(result());
    observer.onLookupResolved(
      result({
        matches: [match({ placements: [{ locationId: 'loc-bin-4', locationName: 'Bin 4', quantity: 12 }] })],
      }),
    );

    expect(c.events).toHaveLength(2);
  });

  it('suppresses exactly the deliveries that would share an id', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 3000, now: t.now });

    observer.onLookupResolved(result());
    t.advance(1000);
    observer.onLookupResolved(result());
    t.advance(2000);
    observer.onLookupResolved(result());

    // Two deliveries, never the same id — a sink deduping on id would drop nothing.
    expect(new Set(c.events.map((e) => e.id)).size).toBe(c.events.length);
    expect(c.events).toHaveLength(2);
  });

  it('a zero window disables debouncing entirely', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({ deliver: c.deliver, debounceMs: 0, now: t.now });

    observer.onLookupResolved(result());
    observer.onLookupResolved(result());

    expect(c.events).toHaveLength(2);
  });

  it('keeps its debounce state bounded under a spray of distinct queries', () => {
    const c = collector();
    const t = clock();
    const observer = createLookupObserver({
      deliver: c.deliver,
      debounceMs: 3000,
      now: t.now,
      maxKeys: 8,
    });

    for (let i = 0; i < 500; i += 1) observer.onLookupResolved(result({ query: `part ${i}` }));

    // Every distinct query emitted (nothing was wrongly suppressed) …
    expect(c.events).toHaveLength(500);
    // … and the memory did not grow with them: the oldest key was evicted long ago, so the very
    // first query is emittable again immediately despite still being inside its window.
    observer.onLookupResolved(result({ query: 'part 0' }));
    expect(c.events).toHaveLength(501);
  });

  it('swallows and reports a throwing sink rather than failing the lookup', () => {
    const errors: Error[] = [];
    const observer = createLookupObserver({
      deliver: () => {
        throw new Error('sink exploded');
      },
      onError: (e) => void errors.push(e),
    });

    expect(() => observer.onLookupResolved(result())).not.toThrow();
    expect(errors.map((e) => e.message)).toEqual(['sink exploded']);
  });
});
