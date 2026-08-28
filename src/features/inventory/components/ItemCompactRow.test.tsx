import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';

/**
 * Render tests for the Compact row (issue #444).
 *
 * The mode's claim is that it is a *single line* carrying a name and one field, and that is what
 * is asserted: everything a Data row adds — the corner badge, the stock value, and the rest of
 * the configured field list — must be absent, because the moment any of them comes back Compact
 * and Data are the same row with different padding. The action menu is the one thing that stays, for
 * the same reason it stays on the gallery tile: the pointer-only body-click shortcut needs a
 * labelled control behind it.
 */
const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));

vi.mock('./ItemActions', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    ItemActions: forwardRef((_props: unknown, ref: React.Ref<{ open: (kind: string) => void }>) => {
      useImperativeHandle(ref, () => ({ open: openSpy }), []);
      return (
        <div data-testid="item-actions">
          <button type="button" aria-label="More actions">
            act
          </button>
        </div>
      );
    }),
  };
});
// The two things a Data row adds beside its name that a Compact row must not. Mocked *here* so
// their absence is falsifiable: querying a testid no component emits would pass whatever the row
// rendered, which is how the first version of this test managed to assert nothing at all.
vi.mock('./CardBadge', () => ({
  CardBadge: () => <span data-testid="card-badge">badge</span>,
}));
vi.mock('./ItemStockValue', () => ({
  ItemStockValue: () => <span data-testid="item-stock-value">stock</span>,
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    quantity: (n: number) => String(n),
    measure: (n: number, unit: string) => `${n} ${unit}`,
  }),
}));

import { ItemCompactRow } from './ItemCompactRow';

const BASE: Item = {
  id: 'item-1',
  name: 'Brass hinge',
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

function renderRow(item: Item, extra: Partial<React.ComponentProps<typeof ItemCompactRow>> = {}) {
  return render(<ItemCompactRow item={item} locations={[]} locationName="Workshop" {...extra} />);
}

afterEach(() => {
  cleanup();
  openSpy.mockClear();
});

describe('ItemCompactRow — one line, one field', () => {
  it('shows the name and the first configured field that has a value', () => {
    renderRow(makeItem(), { fieldOrder: ['location', 'category'] });
    expect(screen.getByText('Brass hinge')).not.toBeNull();
    expect(screen.getByText('Workshop')).not.toBeNull();
  });

  it('shows only that one field, never the whole configured list', () => {
    renderRow(makeItem(), { fieldOrder: ['location', 'category'], categoryName: 'Fixings' });
    expect(screen.getByText('Workshop')).not.toBeNull();
    // Category resolves to a real value here and is still not drawn — the line stops at one.
    expect(screen.queryByText('Fixings')).toBeNull();
  });

  it('carries none of the Data row’s extra furniture', () => {
    renderRow(makeItem());
    // `ItemRow` draws both of these beside its name (see ItemRow.tsx); a Compact line draws
    // neither. Bring either back and this goes red, which is the whole point — without it
    // Compact would drift back into being a Data row with less padding.
    expect(screen.queryByTestId('card-badge')).toBeNull();
    expect(screen.queryByTestId('item-stock-value')).toBeNull();
  });

  it('draws no trailing value when the item fills none of the configured fields', () => {
    renderRow(makeItem(), { fieldOrder: [] });
    expect(screen.getByText('Brass hinge')).not.toBeNull();
    expect(screen.queryByText('Workshop')).toBeNull();
  });
});

describe('ItemCompactRow — list semantics and actions', () => {
  it('is one positioned list item, so virtualisation stays invisible to assistive tech', () => {
    renderRow(makeItem(), { ariaPosInSet: 12, ariaSetSize: 340 });
    const row = screen.getByRole('listitem');
    expect(row.getAttribute('aria-posinset')).toBe('12');
    expect(row.getAttribute('aria-setsize')).toBe('340');
  });

  it('keeps the action menu, so the mode is reachable without a pointer', () => {
    renderRow(makeItem());
    expect(screen.getByRole('button', { name: 'More actions' })).not.toBeNull();
  });

  it('shows the favourite star only for a favourited item', () => {
    renderRow(makeItem());
    expect(screen.queryByRole('img', { name: 'Favourite' })).toBeNull();
    cleanup();
    renderRow(makeItem({ isFavourite: true }));
    expect(screen.getByRole('img', { name: 'Favourite' })).not.toBeNull();
  });

  it('offers a named selection checkbox only while selecting', () => {
    const onToggle = vi.fn();
    const item = makeItem();
    expect(screen.queryByTestId('item-select')).toBeNull();
    renderRow(item, { selection: { onToggle }, selected: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Brass hinge' }));
    expect(onToggle).toHaveBeenCalledWith(item);
  });
});
