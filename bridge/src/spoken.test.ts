/**
 * Phase HA-2 unit tests for the pure spoken-answer shaper. No DB, no hydration — the
 * shaper is fed hand-built {@link WhereIsMatch} objects (synthetic, no real data) so the
 * voice phrasing is pinned down in isolation: every found-one / found-several / not-found
 * branch, plus the "on/in" preposition choice.
 */
import { describe, expect, it } from 'vitest';
import { speakWhereIs } from './spoken.ts';
import type { WhereIsMatch } from './query.ts';

function match(over: Partial<WhereIsMatch> = {}): WhereIsMatch {
  return {
    id: 'item-x',
    name: 'Widget',
    quantity: 0,
    locationName: null,
    mpn: null,
    manufacturer: null,
    placements: [],
    ...over,
  };
}

describe('speakWhereIs', () => {
  it('reports a not-found query', () => {
    expect(speakWhereIs('M3 screws', [])).toBe('I couldn\'t find anything matching "M3 screws".');
  });

  it('reports a single item at a single location, choosing "in" for a drawer', () => {
    const m = match({
      name: 'M3 x 10 Hex Bolt',
      quantity: 42,
      placements: [{ locationName: 'Drawer A', quantity: 42 }],
    });
    expect(speakWhereIs('M3 bolt', [m])).toBe('Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock.');
  });

  it('chooses "on" for a shelf', () => {
    const m = match({
      name: 'ESP32 Dev Board',
      quantity: 5,
      placements: [{ locationName: 'Shelf 2', quantity: 5 }],
    });
    expect(speakWhereIs('esp32', [m])).toBe('Your ESP32 Dev Board is on Shelf 2 — 5 in stock.');
  });

  it('breaks a single item across multiple locations', () => {
    const m = match({
      name: 'ESP32 Dev Board',
      quantity: 7,
      placements: [
        { locationName: 'Shelf 2', quantity: 5 },
        { locationName: 'Bin 4', quantity: 2 },
      ],
    });
    expect(speakWhereIs('esp32', [m])).toBe(
      'Your ESP32 Dev Board is spread across 2 locations: 5 on Shelf 2 and 2 in Bin 4 — 7 in total.',
    );
  });

  it('handles a found item with no stock recorded', () => {
    const m = match({ name: 'Ghost Part', quantity: 0, locationName: 'Drawer A', placements: [] });
    expect(speakWhereIs('ghost', [m])).toBe("Your Ghost Part is in Drawer A, but there's none in stock.");
  });

  it('lists several matches with their primary location', () => {
    const matches = [
      match({ id: 'a', name: 'M3 Bolt', placements: [{ locationName: 'Drawer A', quantity: 42 }] }),
      match({ id: 'b', name: 'M3 Washer', placements: [{ locationName: 'Drawer A', quantity: 100 }] }),
    ];
    expect(speakWhereIs('M3', matches)).toBe(
      'I found 2 items matching "M3": M3 Bolt in Drawer A and M3 Washer in Drawer A.',
    );
  });

  it('caps the named items and summarises the remainder', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      match({ id: `i${i}`, name: `Part ${i}`, placements: [{ locationName: 'Bin 4', quantity: 1 }] }),
    );
    expect(speakWhereIs('part', matches)).toBe(
      'I found 5 items matching "part": Part 0 in Bin 4, Part 1 in Bin 4, Part 2 in Bin 4 and 2 more.',
    );
  });
});
