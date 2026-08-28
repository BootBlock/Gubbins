import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';

/**
 * Render tests for the Gallery tile (issue #444).
 *
 * Three things earn a test here, and all three are the reasons the mode exists rather than
 * incidental markup. The picture box must never be empty — the whole argument for Gallery over a
 * list collapses if a photoless item leaves a hole. The caption must be the first field that has
 * a value. And the tile must keep its action menu, because the pointer-only body-click shortcut
 * is only defensible while a keyboard user reaches the same actions from a labelled control.
 *
 * The heavy children (the action menu, the object-URL thumbnail) are stubbed, as in the sibling
 * card and row tests, so this exercises the tile's own branches.
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
// The real Thumbnail mints an object URL in an effect; here only "did it get the bytes" matters.
vi.mock('./Thumbnail', () => ({
  Thumbnail: ({ alt }: { alt: string }) => <img data-testid="thumbnail" alt={alt} />,
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    quantity: (n: number) => String(n),
    measure: (n: number, unit: string) => `${n} ${unit}`,
  }),
}));

import { ItemGalleryTile } from './ItemGalleryTile';

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

function renderTile(item: Item, extra: Partial<React.ComponentProps<typeof ItemGalleryTile>> = {}) {
  return render(<ItemGalleryTile item={item} locations={[]} locationName="Workshop" {...extra} />);
}

afterEach(() => {
  cleanup();
  openSpy.mockClear();
});

describe('ItemGalleryTile — the picture box', () => {
  it('shows the photo when the item has one', () => {
    renderTile(makeItem({ thumbnailBlob: new Uint8Array([1, 2, 3]) }));
    expect(screen.getByTestId('thumbnail')).not.toBeNull();
    expect(screen.getByAltText('Brass hinge')).not.toBeNull();
  });

  it('falls back to the category glyph rather than an empty box', () => {
    renderTile(makeItem(), { categoryGlyph: '🔩' });
    expect(screen.queryByTestId('thumbnail')).toBeNull();
    expect(screen.getByText('🔩')).not.toBeNull();
  });

  it('still draws something for an item with neither a photo nor a glyph', () => {
    const { container } = renderTile(makeItem());
    expect(screen.queryByTestId('thumbnail')).toBeNull();
    // The last-resort package glyph — decorative, so it is found as an SVG, not by role.
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('ItemGalleryTile — the caption', () => {
  it('captions with the first configured field that has a value', () => {
    renderTile(makeItem(), { fieldOrder: ['location', 'category'] });
    expect(screen.getByText('Workshop')).not.toBeNull();
  });

  it('skips a field the item has nothing for rather than captioning an em-dash', () => {
    // Category comes first but this item has none, so the caption falls through to Location.
    renderTile(makeItem(), { fieldOrder: ['category', 'location'], categoryName: null });
    expect(screen.getByText('Workshop')).not.toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('draws no caption line at all when nothing resolved', () => {
    renderTile(makeItem(), { fieldOrder: [] });
    expect(screen.getByText('Brass hinge')).not.toBeNull();
    expect(screen.queryByText('Workshop')).toBeNull();
  });
});

describe('ItemGalleryTile — list semantics and actions', () => {
  it('is one positioned list item, so virtualisation stays invisible to assistive tech', () => {
    renderTile(makeItem(), { ariaPosInSet: 12, ariaSetSize: 340 });
    const tile = screen.getByRole('listitem');
    expect(tile.getAttribute('aria-posinset')).toBe('12');
    expect(tile.getAttribute('aria-setsize')).toBe('340');
  });

  it('keeps the action menu, so the mode is reachable without a pointer', () => {
    renderTile(makeItem());
    expect(screen.getByRole('button', { name: 'More actions' })).not.toBeNull();
  });

  it('offers a named selection checkbox only while selecting', () => {
    const onToggle = vi.fn();
    const item = makeItem();
    expect(screen.queryByTestId('item-select')).toBeNull();
    renderTile(item, { selection: { onToggle }, selected: false });
    const box = screen.getByRole('checkbox', { name: 'Select Brass hinge' });
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith(item);
  });
});
