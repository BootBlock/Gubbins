import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { Item } from '@/db/repositories';

/**
 * List semantics for the virtualised flat list (issue #208). Only a screenful of rows exists
 * in the DOM, so a screen reader learns the shape of the result set from the container's
 * `role="list"` and from each row's absolute `aria-posinset` / `aria-setsize` — never from
 * counting the mounted elements. The leaf presentations are stubbed to inert markers that
 * echo those two props back (per the [[component-test-gotchas]] guidance), so this exercises
 * the list's own numbering rather than re-testing the card and the row.
 */

vi.mock('./ItemCard', () => ({
  ItemCard: ({
    item,
    ariaPosInSet,
    ariaSetSize,
  }: {
    item: { id: string };
    ariaPosInSet?: number;
    ariaSetSize?: number;
  }) => (
    <div role="listitem" aria-posinset={ariaPosInSet} aria-setsize={ariaSetSize}>
      {item.id}
    </div>
  ),
}));
vi.mock('./ItemRow', () => ({
  ItemRow: ({
    item,
    ariaPosInSet,
    ariaSetSize,
  }: {
    item: { id: string };
    ariaPosInSet?: number;
    ariaSetSize?: number;
  }) => (
    <div role="listitem" aria-posinset={ariaPosInSet} aria-setsize={ariaSetSize}>
      {item.id}
    </div>
  ),
}));

import { ItemList } from './ItemList';

function items(count: number, from = 0): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${from + i}`, locationId: 'loc-1' }) as Item);
}

/**
 * Give the DOM a real viewport for the duration of a test. happy-dom reports every element as
 * zero-sized, and a virtualizer over a zero-height scroller renders nothing at all — so these
 * tests have to state how big the box is before they can assert what lands in it. Restored by
 * `vi.restoreAllMocks()` in the shared afterEach.
 */
function withViewport(width = 1000, height = 800) {
  // The virtualizer sizes its scroller from offsetWidth/offsetHeight; the Visual density's
  // column count comes from clientWidth. All three are hard-wired to 0 here.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
}

const BASE_PROPS = {
  firstItemIndex: 0,
  locations: [],
  density: 'data' as const,
  locationName: (id: string) => id,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => {},
  hasPreviousPage: false,
  isFetchingPreviousPage: false,
  fetchPreviousPage: () => {},
  cardFields: {
    order: [] as string[],
    customFields: new Map(),
    categoryName: () => null,
    categoryGlyph: () => null,
    values: undefined,
  },
};

/** The rendered rows, in DOM order, as `[position, setSize]` pairs. */
function positions(list: HTMLElement): Array<[string | null, string | null]> {
  return within(list)
    .getAllByRole('listitem')
    .map((el) => [el.getAttribute('aria-posinset'), el.getAttribute('aria-setsize')]);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ItemList — list semantics (issue #208)', () => {
  it('declares a labelled list and numbers each row against the true match total', () => {
    withViewport();
    render(<ItemList {...BASE_PROPS} items={items(3)} totalCount={340} />);
    const list = screen.getByRole('list', { name: 'Inventory items' });
    expect(positions(list)).toEqual([
      ['1', '340'],
      ['2', '340'],
      ['3', '340'],
    ]);
  });

  it('numbers rows absolutely once a leading page has been trimmed off the front', () => {
    // The resident window starts at absolute item 2, so the first two rows are placeholders
    // being refilled and the three real rows carry their absolute positions, not 1–3.
    withViewport();
    render(<ItemList {...BASE_PROPS} items={items(3, 2)} firstItemIndex={2} totalCount={340} />);
    expect(positions(screen.getByRole('list'))).toEqual([
      ['3', '340'],
      ['4', '340'],
      ['5', '340'],
    ]);
  });

  it('falls back to the loaded span as the set size when no total is known and nothing is left to fetch', () => {
    withViewport();
    render(<ItemList {...BASE_PROPS} items={items(3)} />);
    expect(positions(screen.getByRole('list'))).toEqual([
      ['1', '3'],
      ['2', '3'],
      ['3', '3'],
    ]);
  });

  it('reports an unknown set size rather than the resident count while more pages remain', () => {
    withViewport();
    render(<ItemList {...BASE_PROPS} items={items(3)} hasNextPage />);
    expect(positions(screen.getByRole('list'))).toEqual([
      ['1', '-1'],
      ['2', '-1'],
      ['3', '-1'],
    ]);
  });

  it('numbers straight across a Visual row that packs several cards side by side', () => {
    // 1000px wide / 280px minimum = three columns, so five items fill one full row and part
    // of a second — and the numbering has to run across the row, not down it.
    withViewport();
    render(<ItemList {...BASE_PROPS} items={items(5)} density="visual" totalCount={340} />);
    expect(positions(screen.getByRole('list')).map(([pos]) => pos)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps the Table density a table, not a list', () => {
    withViewport();
    render(<ItemList {...BASE_PROPS} items={items(3)} density="table" totalCount={340} />);
    expect(screen.getByRole('table', { name: 'Inventory items' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
