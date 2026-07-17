import { describe, it, expect } from 'vitest';
import { includesAllTerms, splitSearchTerms } from './text-terms';

/**
 * The shared term-AND-substring matcher behind the glyph picker's filter and the
 * category-preset picker's library search. Both consumers document themselves as
 * sharing one model, so the rules are pinned here once.
 */
describe('splitSearchTerms', () => {
  it('splits on any whitespace run, lower-cases, and drops blanks', () => {
    expect(splitSearchTerms('  Arrow   DOWN ')).toEqual(['arrow', 'down']);
    expect(splitSearchTerms('one')).toEqual(['one']);
  });

  it('yields no terms for an empty or whitespace-only query', () => {
    expect(splitSearchTerms('')).toEqual([]);
    expect(splitSearchTerms('   ')).toEqual([]);
  });
});

describe('includesAllTerms', () => {
  it('requires every term as a case-insensitive substring, in either order', () => {
    const hay = 'Book — author, ISBN, format';
    expect(includesAllTerms(hay, splitSearchTerms('isbn author'))).toBe(true);
    expect(includesAllTerms(hay, splitSearchTerms('author isbn'))).toBe(true);
    expect(includesAllTerms(hay, splitSearchTerms('isbn voltage'))).toBe(false);
  });

  it('matches everything when there are no terms (the browse state)', () => {
    expect(includesAllTerms('anything', [])).toBe(true);
  });
});
