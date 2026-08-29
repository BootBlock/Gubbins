import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, ACHIEVEMENT_IDS, COUNT_ACHIEVEMENTS } from './registry';

describe('achievement registry', () => {
  it('gives every achievement a distinct id', () => {
    // Ids are persisted, so a duplicate would silently merge two achievements into one record.
    expect(new Set(ACHIEVEMENT_IDS).size).toBe(ACHIEVEMENTS.length);
  });

  it('lists the count achievements smallest first', () => {
    const thresholds = COUNT_ACHIEVEMENTS.map((a) => a.itemCount);
    expect(thresholds).toEqual([...thresholds].sort((a, b) => a - b));
  });

  it('derives the count achievements from the registry, and only those', () => {
    // The watcher reads COUNT_ACHIEVEMENTS; this is what stops it falling behind the registry.
    expect(COUNT_ACHIEVEMENTS.map((a) => a.id)).toEqual(
      ACHIEVEMENTS.filter((a) => a.itemCount !== undefined)
        .map((a) => ({ id: a.id, itemCount: a.itemCount as number }))
        .sort((a, b) => a.itemCount - b.itemCount)
        .map((a) => a.id),
    );
  });
});
