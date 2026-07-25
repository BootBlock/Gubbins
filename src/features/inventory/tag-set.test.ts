import { describe, it, expect } from 'vitest';
import { projectTagSet } from './tag-set';

const tag = (id: string, name: string) => ({ id, name, updatedAt: 0 });

describe('projectTagSet (issue #293)', () => {
  it('reuses the cached row for a name that is already applied', () => {
    const cached = [tag('t1', 'fragile')];
    expect(projectTagSet(cached, ['fragile'])).toEqual([tag('t1', 'fragile')]);
  });

  it('matches the cached row case-insensitively, keeping the submitted spelling out of it', () => {
    const cached = [tag('t1', 'fragile')];
    expect(projectTagSet(cached, ['FRAGILE'])).toEqual([tag('t1', 'fragile')]);
  });

  it('matches the cached row past ASCII too, so an accented chip is not doubled (issue #342)', () => {
    // The optimistic patch has to reach the verdict the write will: `TagRepository` folds
    // `Ölkanne` onto `ölkanne`, so the chip must resolve to the cached row rather than flashing
    // a second one that the refetch then removes.
    const cached = [tag('t1', 'Ölkanne')];
    expect(projectTagSet(cached, ['ölkanne'])).toEqual([tag('t1', 'Ölkanne')]);
    expect(projectTagSet([], ['Ölkanne', 'ÖLKANNE']).map((t) => t.name)).toEqual(['Ölkanne']);
  });

  it('mints a provisional row for a genuinely new name', () => {
    const [row] = projectTagSet([], ['heavy']);
    expect(row?.name).toBe('heavy');
    expect(row?.id).toBeTruthy();
  });

  it('trims, drops blanks and collapses duplicates case-insensitively', () => {
    expect(projectTagSet([], ['  heavy  ', '', 'HEAVY', '   ']).map((t) => t.name)).toEqual(['heavy']);
  });

  it('orders by name case-insensitively, as the repository reads them back', () => {
    expect(projectTagSet([], ['zeta', 'Alpha', 'beta']).map((t) => t.name)).toEqual([
      'Alpha',
      'beta',
      'zeta',
    ]);
  });

  it('treats a missing cache as empty', () => {
    expect(projectTagSet(undefined, ['solo']).map((t) => t.name)).toEqual(['solo']);
  });
});
