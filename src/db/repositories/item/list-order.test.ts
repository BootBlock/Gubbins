/**
 * Unit tests for the item-list ordering + keyset-seek SSOT (issue #172). The `ORDER BY` rendering
 * must stay byte-identical to the historical order (plus the unique id tiebreak), and the seek
 * predicate must be the exact lexicographic "strictly after" of that same order — the two are built
 * from one spec precisely so they can never drift.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSeekPredicate,
  extractCursor,
  renderOrderBy,
  resolveItemOrder,
  reverseOrder,
} from './list-order';
import type { ItemRow } from '../types';

describe('resolveItemOrder + renderOrderBy', () => {
  it('renders the favourites-first default order with a unique id tiebreak', () => {
    expect(renderOrderBy(resolveItemOrder(undefined))).toBe(
      'items.is_favourite DESC, items.name COLLATE NOCASE ASC, ' +
        'items.serial_no ASC, items.created_at ASC, items.id ASC',
    );
  });

  it('renders an explicit sort NULLs-last, collated for text, favourites-first, id-tiebroken', () => {
    expect(renderOrderBy(resolveItemOrder([{ field: 'name', direction: 'asc' }]))).toBe(
      'items.is_favourite DESC, (items.name IS NULL), items.name COLLATE NOCASE ASC, items.id ASC',
    );
  });

  it('renders a numeric descending sort with its NULLs-last guard', () => {
    expect(renderOrderBy(resolveItemOrder([{ field: 'quantity', direction: 'desc' }]))).toBe(
      'items.is_favourite DESC, (items.quantity IS NULL), items.quantity DESC, items.id ASC',
    );
  });

  it('reverses direction and mirrors NULLs placement for a backward seek', () => {
    // Forward default: fav DESC, name ASC, serial_no ASC (NULLs first), created_at ASC, id ASC.
    // Reversed: fav ASC, name DESC, serial_no DESC (NULLs last → guarded), created_at DESC, id DESC.
    expect(renderOrderBy(reverseOrder(resolveItemOrder(undefined)))).toBe(
      'items.is_favourite ASC, items.name COLLATE NOCASE DESC, ' +
        '(items.serial_no IS NULL), items.serial_no DESC, items.created_at DESC, items.id DESC',
    );
  });
});

describe('extractCursor', () => {
  it('reads the ordering columns from a row, in spec order', () => {
    const row = { id: 'i9', is_favourite: 1, name: 'Widget', serial_no: 3, created_at: 42 } as ItemRow;
    expect(extractCursor(row, resolveItemOrder(undefined))).toEqual([1, 'Widget', 3, 42, 'i9']);
  });
});

describe('buildSeekPredicate — default order', () => {
  it('builds the lexicographic "strictly after" chain, NULL serial_no handled at build time', () => {
    const order = resolveItemOrder(undefined);
    const cursor = [0, 'Foo', null, 123, 'abc']; // fav=0, name='Foo', serial_no=NULL, created_at=123, id='abc'
    const { sql, params } = buildSeekPredicate(order, cursor);
    expect(sql).toBe(
      '(items.is_favourite < ? OR ' +
        '(items.is_favourite = ? AND items.name > ? COLLATE NOCASE) OR ' +
        '(items.is_favourite = ? AND items.name = ? COLLATE NOCASE AND items.serial_no IS NOT NULL) OR ' +
        '(items.is_favourite = ? AND items.name = ? COLLATE NOCASE AND items.serial_no IS NULL ' +
        'AND items.created_at > ?) OR ' +
        '(items.is_favourite = ? AND items.name = ? COLLATE NOCASE AND items.serial_no IS NULL ' +
        'AND items.created_at = ? AND items.id > ?))',
    );
    expect(params).toEqual([0, 0, 'Foo', 0, 'Foo', 0, 'Foo', 123, 0, 'Foo', 123, 'abc']);
  });
});

describe('buildSeekPredicate — explicit NULLs-last sort', () => {
  it('treats a NULL as the maximum: nothing follows it at that column, only later tiebreaks', () => {
    // Sort by unit_cost DESC (NULLs last). A cursor whose unit_cost is NULL sits at the very end
    // of the non-favourite block, so no row follows it via unit_cost — continuation falls to id.
    const order = resolveItemOrder([{ field: 'unitCost', direction: 'desc' }]);
    const cursor = [0, null, 'zzz']; // fav=0, unit_cost=NULL, id='zzz'
    const { sql, params } = buildSeekPredicate(order, cursor);
    expect(sql).toBe(
      '(items.is_favourite < ? OR ' +
        '(items.is_favourite = ? AND items.unit_cost IS NULL AND items.id > ?))',
    );
    expect(params).toEqual([0, 0, 'zzz']);
  });

  it('a non-NULL value also admits NULL rows as "after" under NULLs-last', () => {
    const order = resolveItemOrder([{ field: 'unitCost', direction: 'asc' }]);
    const cursor = [0, 500, 'abc']; // fav=0, unit_cost=500, id='abc'
    const { sql, params } = buildSeekPredicate(order, cursor);
    expect(sql).toBe(
      '(items.is_favourite < ? OR ' +
        '(items.is_favourite = ? AND (items.unit_cost > ? OR items.unit_cost IS NULL)) OR ' +
        '(items.is_favourite = ? AND items.unit_cost = ? AND items.id > ?))',
    );
    expect(params).toEqual([0, 0, 500, 0, 500, 'abc']);
  });
});
