import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, ACHIEVEMENT_IDS, COUNT_ACHIEVEMENTS } from './registry';

describe('achievement registry', () => {
  it('gives every achievement a distinct id', () => {
    // Ids are persisted, so a duplicate would silently merge two achievements into one record.
    expect(new Set(ACHIEVEMENT_IDS).size).toBe(ACHIEVEMENTS.length);
  });

  it('offers exactly the threshold achievements to the watcher', () => {
    // Pinned literally rather than re-derived with the implementation's own filter: the point is
    // to catch an entry that loses its `itemCount`, or an event achievement leaking into the list
    // the watcher awards from the item count. Adding a threshold means updating this line.
    expect(COUNT_ACHIEVEMENTS.map((a) => a.id)).toEqual([
      'first-item',
      'ten-items',
      'hundred-items',
      'thousand-items',
    ]);
    expect(COUNT_ACHIEVEMENTS.map((a) => a.itemCount)).toEqual([1, 10, 100, 1000]);
  });

  it('leaves the event achievements out of it', () => {
    // Their ids must never reach the watcher, which would otherwise award a stock-take to anyone
    // holding enough items.
    const eventIds = ACHIEVEMENTS.filter((a) => a.itemCount === undefined).map((a) => a.id);
    expect(eventIds).toEqual(['stock-take', 'location-count']);
    for (const id of eventIds) {
      expect(COUNT_ACHIEVEMENTS.some((a) => a.id === id)).toBe(false);
    }
  });
});
