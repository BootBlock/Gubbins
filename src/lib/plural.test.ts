import { describe, expect, it } from 'vitest';

import { plural } from './plural';

describe('plural', () => {
  it('returns the singular for exactly one', () => {
    expect(plural(1, 'item')).toBe('item');
  });

  it('appends the regular +s rule for any non-one count', () => {
    expect(plural(0, 'item')).toBe('items');
    expect(plural(2, 'item')).toBe('items');
    expect(plural(42, 'match', 'matches')).toBe('matches');
  });

  it('uses the explicit plural form for irregular nouns', () => {
    expect(plural(1, 'category', 'categories')).toBe('category');
    expect(plural(3, 'category', 'categories')).toBe('categories');
    expect(plural(0, 'entry', 'entries')).toBe('entries');
  });

  it('treats negative counts as plural (only exactly one is singular)', () => {
    expect(plural(-1, 'item')).toBe('items');
  });
});
