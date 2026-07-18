import { describe, it, expect } from 'vitest';
import { ITEM_SORT_FIELDS } from '@/db/repositories';
import {
  DEFAULT_INVENTORY_SORT,
  INVENTORY_SORT_FIELDS,
  normaliseInventorySort,
  type InventorySort,
} from '@/state/stores/useLayoutStore';
import {
  SORT_MODES,
  columnAriaSort,
  initialDirection,
  nextSortForColumn,
  sortMode,
  toItemSort,
} from './sorting';

const sort = (
  field: InventorySort['field'],
  direction: InventorySort['direction'] = 'asc',
): InventorySort => ({
  field,
  direction,
});

describe('SORT_MODES', () => {
  // Compared as sorted sets, not sequences: the menu is deliberately ordered by usefulness
  // (Name, Quantity, Unit cost, …) rather than by the SQL module's declaration order. What must
  // hold is that the two stay *exhaustive* of each other — a field added to the data layer's
  // allow-list but never offered in the UI is exactly the gap this control was built to close.
  it('offers exactly the data layer’s sortable fields, plus the default order', () => {
    expect([...SORT_MODES.map((m) => m.value)].sort()).toEqual(['default', ...ITEM_SORT_FIELDS].sort());
  });

  it('leads with the default order, so the menu opens on the way to switch sorting off', () => {
    expect(SORT_MODES[0]!.value).toBe('default');
  });

  it('gives every field a direction pair except the default order, which has no direction', () => {
    for (const mode of SORT_MODES) {
      if (mode.value === 'default') expect(mode.directionLabels).toBeNull();
      else expect(mode.directionLabels).not.toBeNull();
    }
  });

  it('falls back to the default descriptor for an unknown field', () => {
    expect(sortMode('nope' as InventorySort['field']).value).toBe('default');
  });
});

describe('toItemSort', () => {
  it('omits the sort entirely under the default order, so the repository keeps its own', () => {
    expect(toItemSort(DEFAULT_INVENTORY_SORT)).toBeUndefined();
  });

  it('translates a chosen field and direction into a single repository sort term', () => {
    expect(toItemSort(sort('quantity', 'desc'))).toEqual([{ field: 'quantity', direction: 'desc' }]);
  });
});

describe('initialDirection', () => {
  it('reads text ascending and numbers/dates descending', () => {
    expect(initialDirection('name')).toBe('asc');
    expect(initialDirection('manufacturer')).toBe('asc');
    expect(initialDirection('quantity')).toBe('desc');
    expect(initialDirection('unitCost')).toBe('desc');
    expect(initialDirection('createdAt')).toBe('desc');
    expect(initialDirection('updatedAt')).toBe('desc');
  });
});

describe('nextSortForColumn', () => {
  it('adopts a newly-activated column at its natural direction', () => {
    expect(nextSortForColumn(DEFAULT_INVENTORY_SORT, 'name')).toEqual(sort('name', 'asc'));
    expect(nextSortForColumn(DEFAULT_INVENTORY_SORT, 'quantity')).toEqual(sort('quantity', 'desc'));
  });

  it('switches straight to a different column rather than inheriting its direction', () => {
    expect(nextSortForColumn(sort('quantity', 'asc'), 'name')).toEqual(sort('name', 'asc'));
  });

  it('cycles the active column: natural → reversed → back to the default order', () => {
    const first = nextSortForColumn(DEFAULT_INVENTORY_SORT, 'name');
    expect(first).toEqual(sort('name', 'asc'));
    const second = nextSortForColumn(first, 'name');
    expect(second).toEqual(sort('name', 'desc'));
    expect(nextSortForColumn(second, 'name')).toEqual(DEFAULT_INVENTORY_SORT);
  });

  it('cycles a descending-natural column the same way, from its own starting point', () => {
    const first = nextSortForColumn(DEFAULT_INVENTORY_SORT, 'quantity');
    expect(first).toEqual(sort('quantity', 'desc'));
    const second = nextSortForColumn(first, 'quantity');
    expect(second).toEqual(sort('quantity', 'asc'));
    expect(nextSortForColumn(second, 'quantity')).toEqual(DEFAULT_INVENTORY_SORT);
  });
});

describe('columnAriaSort', () => {
  it('reports a direction for the active column and "none" for the rest', () => {
    expect(columnAriaSort(sort('name', 'asc'), 'name')).toBe('ascending');
    expect(columnAriaSort(sort('name', 'desc'), 'name')).toBe('descending');
    expect(columnAriaSort(sort('name', 'asc'), 'quantity')).toBe('none');
    expect(columnAriaSort(DEFAULT_INVENTORY_SORT, 'name')).toBe('none');
  });
});

describe('normaliseInventorySort', () => {
  it('accepts a valid persisted sort verbatim', () => {
    expect(normaliseInventorySort({ field: 'unitCost', direction: 'desc' })).toEqual(
      sort('unitCost', 'desc'),
    );
  });

  it('falls back to the default order for a non-object or an unknown field', () => {
    expect(normaliseInventorySort(null)).toEqual(DEFAULT_INVENTORY_SORT);
    expect(normaliseInventorySort('quantity')).toEqual(DEFAULT_INVENTORY_SORT);
    expect(normaliseInventorySort({ field: 'retiredField', direction: 'asc' })).toEqual(
      DEFAULT_INVENTORY_SORT,
    );
  });

  it('keeps a recognised field but repairs an unrecognised direction', () => {
    expect(normaliseInventorySort({ field: 'name', direction: 'sideways' })).toEqual(sort('name', 'asc'));
  });

  it('collapses the default field to the canonical default, whatever direction was stored', () => {
    expect(normaliseInventorySort({ field: 'default', direction: 'desc' })).toEqual(DEFAULT_INVENTORY_SORT);
  });

  it('reconciles every offered field, so no menu entry can be rejected on reload', () => {
    for (const field of INVENTORY_SORT_FIELDS) {
      expect(normaliseInventorySort({ field, direction: 'asc' }).field).toBe(field);
    }
  });
});
