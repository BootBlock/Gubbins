import { beforeEach, describe, expect, it } from 'vitest';
import { migrateAchievements, normaliseUnlocks, useAchievementsStore } from './useAchievementsStore';

const state = () => useAchievementsStore.getState();

beforeEach(() => {
  // Reset to the pristine default so persisted state can't leak between cases.
  useAchievementsStore.setState({ unlocked: {} });
});

describe('useAchievementsStore', () => {
  it('starts with nothing earned', () => {
    expect(state().unlocked).toEqual({});
  });

  it('records an achievement with the instant it was earned', () => {
    state().unlock('first-item', 1_700_000_000_000);
    expect(state().unlocked['first-item']).toBe(1_700_000_000_000);
  });

  it('records a backfilled achievement with no instant', () => {
    state().unlock('first-item', null);
    expect(state().unlocked['first-item']).toBeNull();
    // Null is "earned, date unknown" — distinct from the absent key that means "not earned".
    expect('first-item' in state().unlocked).toBe(true);
  });

  it('keeps the first write — a later backfill cannot erase a known instant', () => {
    state().unlock('first-item', 1_700_000_000_000);
    state().unlock('first-item', null);
    expect(state().unlocked['first-item']).toBe(1_700_000_000_000);
  });

  it('keeps the first write when the same achievement is awarded twice', () => {
    state().unlock('stock-take', 1);
    state().unlock('stock-take', 2);
    expect(state().unlocked['stock-take']).toBe(1);
  });
});

describe('normaliseUnlocks', () => {
  it('keeps a known id with a numeric or null instant', () => {
    expect(normaliseUnlocks({ 'first-item': 12, 'stock-take': null })).toEqual({
      'first-item': 12,
      'stock-take': null,
    });
  });

  it('drops an id the registry no longer knows', () => {
    expect(normaliseUnlocks({ 'first-item': 12, 'retired-award': 34 })).toEqual({
      'first-item': 12,
    });
  });

  it('reads a nonsense instant as "date unknown" rather than a nonsense date', () => {
    expect(normaliseUnlocks({ 'first-item': 'yesterday' })).toEqual({ 'first-item': null });
  });

  it('falls back to nothing earned when the stored value is not an object', () => {
    expect(normaliseUnlocks(undefined)).toEqual({});
    expect(normaliseUnlocks('nonsense')).toEqual({});
    expect(normaliseUnlocks([1, 2])).toEqual({});
  });
});

describe('migrateAchievements (v1 → v2)', () => {
  it('adopts the v1 first-item milestone with no instant', () => {
    // v1 recorded a bare boolean, which says the burst played but not when.
    expect(migrateAchievements({ firstItemCelebrated: true })).toEqual({
      unlocked: { 'first-item': null },
    });
  });

  it('adopts an uncelebrated v1 install as nothing earned', () => {
    expect(migrateAchievements({ firstItemCelebrated: false })).toEqual({ unlocked: {} });
  });

  it('survives a stored value that is not the v1 shape at all', () => {
    expect(migrateAchievements(null)).toEqual({ unlocked: {} });
    expect(migrateAchievements({ firstItemCelebrated: 'yes' })).toEqual({ unlocked: {} });
  });
});
