/**
 * Unit tests for the shared item SQL fragments — specifically the whitelisted `$orderby`
 * clause builder, which turns a validated sort spec into a safe, deterministic `ORDER BY`.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_SORT_FIELDS, itemOrderByClause } from './sql';

describe('itemOrderByClause', () => {
  it('returns null when there is nothing to sort by', () => {
    expect(itemOrderByClause(undefined)).toBeNull();
    expect(itemOrderByClause([])).toBeNull();
  });

  it('emits NULLs-last, a case-insensitive collation for text, and a stable id tiebreak', () => {
    const clause = itemOrderByClause([{ field: 'name', direction: 'asc' }]);
    expect(clause).toBe('(items.name IS NULL), items.name COLLATE NOCASE ASC, items.id ASC');
  });

  it('maps a numeric field and a descending direction', () => {
    const clause = itemOrderByClause([{ field: 'quantity', direction: 'desc' }]);
    expect(clause).toBe('(items.quantity IS NULL), items.quantity DESC, items.id ASC');
  });

  it('chains multiple sort terms in order, then the tiebreak', () => {
    const clause = itemOrderByClause([
      { field: 'unitCost', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
    expect(clause).toBe(
      '(items.unit_cost IS NULL), items.unit_cost DESC, ' +
        '(items.name IS NULL), items.name COLLATE NOCASE ASC, items.id ASC',
    );
  });

  it('only ever references real, whitelisted columns (no free-text field reaches SQL)', () => {
    for (const field of ITEM_SORT_FIELDS) {
      const clause = itemOrderByClause([{ field, direction: 'asc' }])!;
      expect(clause).toMatch(/^\(items\.[a-z_]+ IS NULL\), items\.[a-z_]+/);
    }
  });
});
