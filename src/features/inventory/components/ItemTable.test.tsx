import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import type { CardCustomField } from '../card-fields';

// The action cluster, ± stepper, gauge ring and formatters are stubbed (as in ItemRow.test) so
// this exercises the table's own column model and cell layout, not those heavy children.
vi.mock('./ItemActions', () => ({
  ItemActions: () => <div data-testid="item-actions" />,
}));
vi.mock('./QuantityStepper', () => ({
  QuantityStepper: ({ quantity }: { quantity: number }) => (
    <div data-testid="quantity-stepper">{quantity}</div>
  ),
}));
vi.mock('./GaugeBar', () => ({
  GaugeBar: () => <div data-testid="gauge-bar" />,
  GaugeRing: () => <div data-testid="gauge-ring" />,
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    quantity: (n: number) => String(n),
    measure: (n: number, unit: string) => `${n} ${unit}`,
    relativeTime: (ms: number) => `@${ms}`,
  }),
}));

import { ItemTableHeader, ItemTableRow } from './ItemTable';
import { columnSortField, tableFieldColumns, tableGridColumns } from './item-table-columns';
import { DEFAULT_INVENTORY_SORT, useLayoutStore } from '@/state/stores/useLayoutStore';

const BASE: Item = {
  id: 'item-1',
  name: 'NE555 timer',
  description: null,
  notes: null,
  locationId: 'loc-1',
  categoryId: null,
  trackingMode: 'DISCRETE',
  quantity: 12,
  serialNo: null,
  mpn: null,
  manufacturer: null,
  barcode: null,
  unitCost: null,
  expiryDate: null,
  batchNumber: null,
  lotNumber: null,
  condition: null,
  parentId: null,
  isUnlimited: false,
  isFavourite: false,
  reorderPoint: null,
  reorderGaugePercent: null,
  reorderQty: null,
  acquiredAt: null,
  warrantyExpiresAt: null,
  purchasePrice: null,
  depreciationMonths: null,
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
  gauge: null,
  operationalMetadata: null,
};
const makeItem = (overrides: Partial<Item> = {}): Item => ({ ...BASE, ...overrides });

const customField = (over: Partial<CardCustomField> = {}): CardCustomField => ({
  id: 'cf-1',
  categoryId: 'cat-1',
  name: 'Voltage',
  fieldType: 'TEXT',
  defaultValue: null,
  ...over,
});

afterEach(cleanup);

describe('tableFieldColumns', () => {
  it('maps built-in field ids to their labels, in order', () => {
    const cols = tableFieldColumns(['location', 'category', 'condition'], new Map());
    expect(cols).toEqual([
      { id: 'location', label: 'Location' },
      { id: 'category', label: 'Category' },
      { id: 'condition', label: 'Condition' },
    ]);
  });

  it('drops the quantity field — the dedicated Stock column supersedes it', () => {
    const cols = tableFieldColumns(['location', 'quantity', 'category'], new Map());
    expect(cols.map((c) => c.id)).toEqual(['location', 'category']);
  });

  it('resolves a custom field to its catalogue name, and drops a stale (unknown) one', () => {
    const catalog = new Map([['cf-1', customField()]]);
    const cols = tableFieldColumns(['custom:cf-1', 'custom:gone'], catalog);
    expect(cols).toEqual([{ id: 'custom:cf-1', label: 'Voltage' }]);
  });
});

describe('tableGridColumns', () => {
  it('builds Name + fields + Stock + Actions tracks (no select column by default)', () => {
    const tracks = tableGridColumns(2, false).split(' ').length;
    // name(1) + fields(2) + stock(1) + actions(1) — but minmax(...) contains no spaces here.
    expect(tableGridColumns(2, false)).toContain('8.5rem');
    expect(tableGridColumns(2, false)).toContain('6.5rem');
    expect(tracks).toBeGreaterThan(0);
  });

  it('prepends a narrow select column when selecting', () => {
    expect(tableGridColumns(0, true).startsWith('1.5rem')).toBe(true);
    expect(tableGridColumns(0, false).startsWith('1.5rem')).toBe(false);
  });
});

describe('ItemTableHeader', () => {
  it('renders Name, each field label, Stock, and an Actions header', () => {
    render(
      <ItemTableHeader
        columns={[
          { id: 'location', label: 'Location' },
          { id: 'category', label: 'Category' },
        ]}
        selecting={false}
        gridTemplate={tableGridColumns(2, false)}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Location' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    // No Select header unless we're in selection mode.
    expect(screen.queryByRole('columnheader', { name: 'Select' })).toBeNull();
  });

  it('adds a Select header in selection mode', () => {
    render(<ItemTableHeader columns={[]} selecting gridTemplate={tableGridColumns(0, true)} />);
    expect(screen.getByRole('columnheader', { name: 'Select' })).toBeInTheDocument();
  });
});

describe('columnSortField', () => {
  it('maps the one sortable card-field column to its data-layer field', () => {
    expect(columnSortField('updated')).toBe('updatedAt');
  });

  it('reports columns with no orderable column as unsortable', () => {
    // Joined (location/category/tags), derived (value/condition) and custom fields have no
    // scalar `items` column to order by, so the data layer can't sort them.
    for (const id of ['location', 'category', 'tags', 'value', 'condition', 'custom:cf-1']) {
      expect(columnSortField(id)).toBeNull();
    }
  });
});

describe('ItemTableHeader sorting (issue #128)', () => {
  const cols = [
    { id: 'location', label: 'Location' },
    { id: 'updated', label: 'Last updated' },
  ];
  const renderHeader = () =>
    render(<ItemTableHeader columns={cols} selecting={false} gridTemplate={tableGridColumns(2, false)} />);

  beforeEach(() => {
    useLayoutStore.setState({ inventorySort: DEFAULT_INVENTORY_SORT });
  });

  it('makes sortable columns buttons and leaves the rest inert labels', () => {
    renderHeader();
    expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last updated' })).toBeInTheDocument();
    // Location joins another table — there is nothing to order by, so it stays a plain label.
    expect(screen.queryByRole('button', { name: 'Location' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Location' })).toBeInTheDocument();
  });

  it('reports no sort direction on any column under the default order', () => {
    renderHeader();
    for (const name of ['Name', 'Stock', 'Last updated']) {
      expect(screen.getByRole('columnheader', { name })).toHaveAttribute('aria-sort', 'none');
    }
  });

  it('sorts by a column on click, at that field’s natural direction', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(useLayoutStore.getState().inventorySort).toEqual({ field: 'name', direction: 'asc' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');

    // Stock is a quantity — the useful first look is "what do I have most of".
    fireEvent.click(screen.getByRole('button', { name: 'Stock' }));
    expect(useLayoutStore.getState().inventorySort).toEqual({ field: 'quantity', direction: 'desc' });
    expect(screen.getByRole('columnheader', { name: 'Stock' })).toHaveAttribute('aria-sort', 'descending');
    // The previously-active column stands down rather than keeping a stale arrow.
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none');
  });

  it('cycles the active column back to the default order on a third click', () => {
    renderHeader();
    const name = () => screen.getByRole('button', { name: 'Name' });
    fireEvent.click(name());
    fireEvent.click(name());
    expect(useLayoutStore.getState().inventorySort).toEqual({ field: 'name', direction: 'desc' });
    fireEvent.click(name());
    expect(useLayoutStore.getState().inventorySort).toEqual(DEFAULT_INVENTORY_SORT);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none');
  });
});

describe('ItemTableRow', () => {
  const cols = ['location', 'category'];

  it('renders the name and a cell per configured field, plus the stock and actions', () => {
    render(
      <ItemTableRow
        item={makeItem({ categoryId: 'cat-1' })}
        locations={[]}
        locationName="Workshop"
        gridTemplate={tableGridColumns(cols.length, false)}
        columnIds={cols}
        ariaRowIndex={2}
        categoryName="Timers"
      />,
    );
    expect(screen.getByRole('row')).toHaveAttribute('aria-rowindex', '2');
    expect(screen.getByText('NE555 timer')).toBeInTheDocument();
    expect(screen.getByText('Workshop')).toBeInTheDocument();
    expect(screen.getByText('Timers')).toBeInTheDocument();
    // Active discrete item → the ± stepper stands in for the stock figure.
    expect(screen.getByTestId('quantity-stepper')).toBeInTheDocument();
    expect(screen.getByTestId('item-actions')).toBeInTheDocument();
  });

  it('shows a labelled favourite star in the name cell only for a favourited item', () => {
    const { rerender } = render(
      <ItemTableRow
        item={makeItem({ isFavourite: true })}
        locations={[]}
        locationName="Workshop"
        gridTemplate={tableGridColumns(cols.length, false)}
        columnIds={cols}
        ariaRowIndex={2}
        categoryName={null}
      />,
    );
    expect(screen.getByRole('img', { name: 'Favourite' })).toBeInTheDocument();

    rerender(
      <ItemTableRow
        item={makeItem({ isFavourite: false })}
        locations={[]}
        locationName="Workshop"
        gridTemplate={tableGridColumns(cols.length, false)}
        columnIds={cols}
        ariaRowIndex={2}
        categoryName={null}
      />,
    );
    expect(screen.queryByRole('img', { name: 'Favourite' })).toBeNull();
  });

  it('renders an em-dash for a configured field the item has no value for', () => {
    render(
      <ItemTableRow
        item={makeItem({ categoryId: null })}
        locations={[]}
        locationName="Workshop"
        gridTemplate={tableGridColumns(cols.length, false)}
        columnIds={cols}
        ariaRowIndex={2}
        categoryName={null}
      />,
    );
    // Category is empty for this item → the cell keeps the column aligned with an em-dash.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a selection checkbox reflecting the selected state', () => {
    render(
      <ItemTableRow
        item={makeItem()}
        locations={[]}
        locationName="Workshop"
        gridTemplate={tableGridColumns(cols.length, true)}
        columnIds={cols}
        ariaRowIndex={2}
        selection={{ onToggle: vi.fn() }}
        selected
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Select NE555 timer' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });
});
