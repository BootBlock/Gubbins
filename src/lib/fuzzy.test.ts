import { describe, it, expect } from 'vitest';
import { fuzzyMatch, rankFuzzy, editDistance, similarity } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches a case-insensitive subsequence and records positions', () => {
    const m = fuzzyMatch('pur', 'Purchase orders');
    expect(m).not.toBeNull();
    expect(m?.positions).toEqual([0, 1, 2]);
  });

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'Purchase orders')).toBeNull();
    // right letters, wrong order — still not a subsequence
    expect(fuzzyMatch('rup', 'Purchase orders')).toBeNull();
  });

  it('ignores whitespace in the query', () => {
    const a = fuzzyMatch('pur ord', 'Purchase orders');
    const b = fuzzyMatch('purord', 'Purchase orders');
    expect(a).not.toBeNull();
    expect(a?.score).toBe(b?.score);
  });

  it('treats an empty query as a neutral match-everything', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('scores a start-of-string match above a mid-string one', () => {
    const start = fuzzyMatch('set', 'Settings')!;
    const mid = fuzzyMatch('set', 'Preset')!;
    expect(start.score).toBeGreaterThan(mid.score);
  });

  it('rewards word-boundary (acronym) matches', () => {
    const acronym = fuzzyMatch('po', 'Purchase orders')!;
    // P at start + o at the "orders" boundary should beat a scattered in-word match
    const scattered = fuzzyMatch('po', 'Apollo')!;
    expect(acronym.score).toBeGreaterThan(scattered.score);
  });

  it('matches camelCase humps as boundaries', () => {
    const m = fuzzyMatch('is', 'inventoryScreen');
    expect(m?.positions).toEqual([0, 9]);
  });
});

describe('rankFuzzy', () => {
  const screens = ['Dashboard', 'Inventory', 'Settings', 'Sync', 'Reports'];

  it('keeps only matches, ordered best-first', () => {
    const ranked = rankFuzzy(screens, 's', (s) => s);
    const labels = ranked.map((r) => r.item);
    // Only labels containing an "s" survive ("Inventory" has none).
    expect(labels).not.toContain('Inventory');
    // Start-of-string matches ("Sync", "Settings") outrank the mid-word ones
    // ("Dashboard", "Reports"), so they take the top two slots.
    expect(new Set(labels.slice(0, 2))).toEqual(new Set(['Sync', 'Settings']));
    expect(labels[0][0]).toBe('S');
  });

  it('returns every item in original order for an empty query', () => {
    const ranked = rankFuzzy(screens, '', (s) => s);
    expect(ranked.map((r) => r.item)).toEqual(screens);
  });

  it('is stable for equal scores', () => {
    const items = ['abc', 'abd', 'abe'];
    const ranked = rankFuzzy(items, 'ab', (s) => s);
    expect(ranked.map((r) => r.item)).toEqual(items);
  });
});

describe('editDistance', () => {
  it('is zero for identical strings (case-insensitive)', () => {
    expect(editDistance('inventory', 'inventory')).toBe(0);
    expect(editDistance('Inventory', 'inventory')).toBe(0);
  });

  it('counts a transposition as two edits and a typo as one', () => {
    expect(editDistance('inventroy', 'inventory')).toBe(2); // transposed pair
    expect(editDistance('setttings', 'settings')).toBe(1); // one extra letter
  });

  it('equals the other string length when one side is empty', () => {
    expect(editDistance('', 'reports')).toBe(7);
    expect(editDistance('sync', '')).toBe(4);
  });
});

describe('similarity', () => {
  it('is 1 for identical strings and lower the further apart they are', () => {
    expect(similarity('inventory', 'inventory')).toBe(1);
    expect(similarity('inventroy', 'inventory')).toBeGreaterThan(0.7);
    expect(similarity('xyz', 'inventory')).toBeLessThan(0.3);
  });

  it('treats two empty strings as identical', () => {
    expect(similarity('', '')).toBe(1);
  });

  it('ranks a near-miss above an unrelated string for the same target', () => {
    const target = 'reports';
    expect(similarity('reprots', target)).toBeGreaterThan(similarity('bookings', target));
  });
});
