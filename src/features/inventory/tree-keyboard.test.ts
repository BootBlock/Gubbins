import { describe, it, expect } from 'vitest';
import { resolveTreeKey, type TreeRow } from './tree-keyboard';

/**
 * A small fixture tree, flattened to its *visible* rows in render order:
 *
 *   all            (level 1, synthetic "All items", leaf)
 *   workshop       (level 1, expandable, expanded)
 *     cabinet      (level 2, expandable, collapsed)
 *     bench        (level 2, leaf, deletable)
 *   garage         (level 1, expandable, expanded)
 *     shelf        (level 2, leaf, deletable)
 */
const rows: readonly TreeRow[] = [
  { id: 'all', level: 1, expandable: false, expanded: false, deletable: false },
  { id: 'workshop', level: 1, expandable: true, expanded: true, deletable: true },
  { id: 'cabinet', level: 2, expandable: true, expanded: false, deletable: true },
  { id: 'bench', level: 2, expandable: false, expanded: false, deletable: true },
  { id: 'garage', level: 1, expandable: true, expanded: true, deletable: true },
  { id: 'shelf', level: 2, expandable: false, expanded: false, deletable: true },
];

describe('resolveTreeKey — APG tree keyboard navigation', () => {
  it('returns null for an empty tree', () => {
    expect(resolveTreeKey([], null, 'ArrowDown')).toBeNull();
  });

  it('ArrowDown moves focus to the next visible row', () => {
    expect(resolveTreeKey(rows, 'workshop', 'ArrowDown')).toEqual({ kind: 'focus', id: 'cabinet' });
  });

  it('ArrowDown does not wrap past the last row', () => {
    expect(resolveTreeKey(rows, 'shelf', 'ArrowDown')).toBeNull();
  });

  it('ArrowUp moves focus to the previous visible row', () => {
    expect(resolveTreeKey(rows, 'cabinet', 'ArrowUp')).toEqual({ kind: 'focus', id: 'workshop' });
  });

  it('ArrowUp does not wrap past the first row', () => {
    expect(resolveTreeKey(rows, 'all', 'ArrowUp')).toBeNull();
  });

  it('an unknown focused id enters at the first row on ArrowDown', () => {
    expect(resolveTreeKey(rows, null, 'ArrowDown')).toEqual({ kind: 'focus', id: 'all' });
    expect(resolveTreeKey(rows, 'gone', 'ArrowDown')).toEqual({ kind: 'focus', id: 'all' });
  });

  it('Home and End jump to the first and last visible rows', () => {
    expect(resolveTreeKey(rows, 'cabinet', 'Home')).toEqual({ kind: 'focus', id: 'all' });
    expect(resolveTreeKey(rows, 'cabinet', 'End')).toEqual({ kind: 'focus', id: 'shelf' });
  });

  it('ArrowRight on a collapsed expandable row expands it (does not move focus)', () => {
    expect(resolveTreeKey(rows, 'cabinet', 'ArrowRight')).toEqual({ kind: 'expand', id: 'cabinet' });
  });

  it('ArrowRight on an already-expanded row moves focus to its first child', () => {
    expect(resolveTreeKey(rows, 'workshop', 'ArrowRight')).toEqual({ kind: 'focus', id: 'cabinet' });
  });

  it('ArrowRight on a leaf row is a no-op', () => {
    expect(resolveTreeKey(rows, 'bench', 'ArrowRight')).toBeNull();
  });

  it('ArrowLeft on an expanded row collapses it', () => {
    expect(resolveTreeKey(rows, 'workshop', 'ArrowLeft')).toEqual({ kind: 'collapse', id: 'workshop' });
  });

  it('ArrowLeft on a leaf row moves focus to its parent', () => {
    expect(resolveTreeKey(rows, 'bench', 'ArrowLeft')).toEqual({ kind: 'focus', id: 'workshop' });
  });

  it('ArrowLeft on a collapsed expandable row moves focus to its parent', () => {
    expect(resolveTreeKey(rows, 'cabinet', 'ArrowLeft')).toEqual({ kind: 'focus', id: 'workshop' });
  });

  it('ArrowLeft on a top-level row that cannot collapse is a no-op', () => {
    expect(resolveTreeKey(rows, 'all', 'ArrowLeft')).toBeNull();
  });

  it('Enter and Space select the focused row', () => {
    expect(resolveTreeKey(rows, 'bench', 'Enter')).toEqual({ kind: 'select', id: 'bench' });
    expect(resolveTreeKey(rows, 'bench', ' ')).toEqual({ kind: 'select', id: 'bench' });
  });

  it('Delete removes a deletable focused row', () => {
    expect(resolveTreeKey(rows, 'bench', 'Delete')).toEqual({ kind: 'delete', id: 'bench' });
  });

  it('Delete is a no-op on a non-deletable (system) row', () => {
    expect(resolveTreeKey(rows, 'all', 'Delete')).toBeNull();
  });

  it('F2 begins an inline rename of a mutable focused row', () => {
    expect(resolveTreeKey(rows, 'bench', 'F2')).toEqual({ kind: 'edit', id: 'bench' });
  });

  it('F2 is a no-op on a non-mutable (system) row', () => {
    expect(resolveTreeKey(rows, 'all', 'F2')).toBeNull();
  });

  it('ignores unrelated keys', () => {
    expect(resolveTreeKey(rows, 'bench', 'a')).toBeNull();
    expect(resolveTreeKey(rows, 'bench', 'Tab')).toBeNull();
  });
});
