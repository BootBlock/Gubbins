import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_SEARCHES,
  MAX_SAVED_SEARCH_NAME_LENGTH,
  addSavedSearch,
  removeSavedSearch,
  type SavedSearch,
} from './saved-searches';

/** Deterministic id generator for assertions. */
function counter(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe('addSavedSearch', () => {
  it('prepends a new entry (most-recent first) with a generated id', () => {
    const next = addSavedSearch([], 'Low stock high voltage', 'cap:voltage>3.3 qty<10', counter());
    expect(next).toEqual([{ id: 'id-1', name: 'Low stock high voltage', query: 'cap:voltage>3.3 qty<10' }]);
  });

  it('prepends so the newest is first', () => {
    const make = counter();
    let list = addSavedSearch([], 'First', 'a', make);
    list = addSavedSearch(list, 'Second', 'b', make);
    expect(list.map((s) => s.name)).toEqual(['Second', 'First']);
  });

  it('is a no-op for a blank name or blank query', () => {
    expect(addSavedSearch([], '   ', 'qty>0', counter())).toEqual([]);
    expect(addSavedSearch([], 'Name', '   ', counter())).toEqual([]);
  });

  it('trims the name and query', () => {
    const [entry] = addSavedSearch([], '  Trimmed  ', '  qty>0  ', counter());
    expect(entry).toMatchObject({ name: 'Trimmed', query: 'qty>0' });
  });

  it('updates an existing entry in place when the name matches (case-insensitive)', () => {
    const make = counter();
    let list = addSavedSearch([], 'Caps', 'cap:rohs', make);
    list = addSavedSearch([], 'Other', 'x', make).concat(list);
    const updated = addSavedSearch(list, 'CAPS', 'cap:voltage>5', make);
    expect(updated).toHaveLength(2);
    const caps = updated.find((s) => s.id === 'id-1')!;
    expect(caps).toEqual({ id: 'id-1', name: 'CAPS', query: 'cap:voltage>5' });
  });

  it('clamps an over-long name', () => {
    const longName = 'x'.repeat(MAX_SAVED_SEARCH_NAME_LENGTH + 20);
    const [entry] = addSavedSearch([], longName, 'q', counter());
    expect(entry!.name).toHaveLength(MAX_SAVED_SEARCH_NAME_LENGTH);
  });

  it('caps the list, dropping the oldest', () => {
    const make = counter();
    let list: readonly SavedSearch[] = [];
    for (let i = 0; i < MAX_SAVED_SEARCHES + 5; i++) {
      list = addSavedSearch(list, `Search ${i}`, `q${i}`, make);
    }
    expect(list).toHaveLength(MAX_SAVED_SEARCHES);
    // The newest is first; the five oldest were dropped.
    expect(list[0]!.name).toBe(`Search ${MAX_SAVED_SEARCHES + 4}`);
    expect(list.some((s) => s.name === 'Search 0')).toBe(false);
  });
});

describe('removeSavedSearch', () => {
  it('removes the entry by id', () => {
    const make = counter();
    let list = addSavedSearch([], 'A', 'a', make);
    list = addSavedSearch(list, 'B', 'b', make);
    const next = removeSavedSearch(list, 'id-1');
    expect(next.map((s) => s.name)).toEqual(['B']);
  });

  it('is a no-op for an unknown id', () => {
    const list = addSavedSearch([], 'A', 'a', counter());
    expect(removeSavedSearch(list, 'missing')).toEqual(list);
  });
});
