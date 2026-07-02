import { describe, it, expect } from 'vitest';
import { fuzzyMatch, rankFuzzy } from './fuzzy';

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
    // Everything with an "s" survives; those starting with "s" rank first.
    // Only labels containing an "s" survive ("Inventory" has none).
    expect(labels).not.toContain('Inventory');
    // Start-of-string matches ("Settings", "Sync") outrank the mid-word one ("Dashboard").
    expect(labels.indexOf('Dashboard')).toBe(labels.length - 1);
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
