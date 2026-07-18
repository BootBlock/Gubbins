import { describe, expect, it } from 'vitest';
import { buildSeedItems, SEED_COUNTS, SEED_MAX, SEED_PREFIX } from './seed-data';

describe('buildSeedItems', () => {
  it('builds the requested number of items', () => {
    expect(buildSeedItems(5)).toHaveLength(5);
    expect(buildSeedItems(1)).toHaveLength(1);
  });

  it('marks every item so it can be spotted and deleted afterwards', () => {
    // This is the whole safety story for the one lab feature that writes real data: the user must
    // never be left guessing which items were theirs.
    for (const item of buildSeedItems(50)) {
      expect(item.name.startsWith(`${SEED_PREFIX} `)).toBe(true);
      expect(item.mpn?.startsWith(`${SEED_PREFIX}-`)).toBe(true);
    }
  });

  it('gives every item a distinct name', () => {
    const items = buildSeedItems(500);
    expect(new Set(items.map((i) => i.name)).size).toBe(items.length);
  });

  it('is deterministic — the same index always produces the same item', () => {
    expect(buildSeedItems(20)).toEqual(buildSeedItems(20));
    // …and a longer run is a strict extension of a shorter one, not a reshuffle.
    expect(buildSeedItems(40).slice(0, 20)).toEqual(buildSeedItems(20));
  });

  it('produces plausible, in-range values', () => {
    for (const item of buildSeedItems(200)) {
      expect(item.quantity).toBeGreaterThanOrEqual(0);
      expect(item.quantity).toBeLessThan(40);
      expect(item.unitCost).toBeGreaterThanOrEqual(0);
      expect(item.unitCost).toBeLessThan(200);
      expect(item.manufacturer).toBeTruthy();
    }
  });

  it('clamps a nonsensical count instead of hanging or returning nothing', () => {
    expect(buildSeedItems(0)).toHaveLength(1);
    expect(buildSeedItems(-10)).toHaveLength(1);
    expect(buildSeedItems(Number.NaN)).toHaveLength(1);
    expect(buildSeedItems(2.7)).toHaveLength(2);
    expect(buildSeedItems(SEED_MAX + 5_000)).toHaveLength(SEED_MAX);
  });

  it('offers only counts it can actually build', () => {
    for (const count of SEED_COUNTS) expect(count).toBeLessThanOrEqual(SEED_MAX);
  });
});
