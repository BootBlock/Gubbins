import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { LocationTreeNode } from '@/db/repositories';

/**
 * Behaviour coverage for the "By location" grouped grid ({@link GroupedItemList}). The
 * heavy leaf renderers (ItemCard / ItemRow) and the data hook are stubbed to inert markers
 * (per the [[component-test-gotchas]] guidance), so this exercises the component's own
 * wiring: the nested section headers, the depth-based default expansion, lazy reveal of a
 * collapsed section's items, the empty-leaf note, and the "Show more" pager.
 */

const { sectionResult, fetchNextPage, fetchPreviousPage } = vi.hoisted(() => ({
  // Per-location fake query results, keyed by the section's location id.
  sectionResult: new Map<string, unknown>(),
  fetchNextPage: vi.fn(),
  fetchPreviousPage: vi.fn(),
}));

vi.mock('../queries', () => ({
  useLocationSectionItems: (filters: { locationId: string }) =>
    sectionResult.get(filters.locationId) ?? {
      data: undefined,
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage,
    },
}));

/** The card/row stubs echo the list-position props back (issue #208) so the numbering is assertable. */
type StubItemProps = { item: { id: string }; ariaPosInSet?: number; ariaSetSize?: number };
vi.mock('./ItemCard', () => ({
  ItemCard: ({ item, ariaPosInSet, ariaSetSize }: StubItemProps) => (
    <div data-testid="stub-card" role="listitem" aria-posinset={ariaPosInSet} aria-setsize={ariaSetSize}>
      {item.id}
    </div>
  ),
}));
vi.mock('./ItemRow', () => ({
  ItemRow: ({ item, ariaPosInSet, ariaSetSize }: StubItemProps) => (
    <div data-testid="stub-row" role="listitem" aria-posinset={ariaPosInSet} aria-setsize={ariaSetSize}>
      {item.id}
    </div>
  ),
}));
vi.mock('./ItemTable', () => ({
  ItemTableHeader: () => <div data-testid="stub-table-header" />,
  ItemTableRow: ({ item }: { item: { id: string } }) => <div data-testid="stub-table-row">{item.id}</div>,
}));
// Each section fetches its own on-screen custom-field values (E1); the default config shows
// no custom field, so the query is disabled — stub it so no QueryClient is needed here.
vi.mock('../categories', () => ({
  useItemFieldValues: () => ({ data: undefined }),
}));
// The Tags card field (issue #84) fetches on-screen items' tags; disabled in the default
// config, so stub it like the custom-field-values batch above.
vi.mock('../tags', () => ({
  useItemsTags: () => ({ data: undefined }),
}));

import { GroupedItemList } from './GroupedItemList';

/** A resolved section query carrying `rows`, optionally with a further page. */
function page(ids: string[], hasNextPage = false) {
  return {
    data: { pages: [{ rows: ids.map((id) => ({ id, locationId: id.split('-')[0] })) }] },
    isLoading: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
  };
}

/** A resolved section query holding `count` items, as a window starting at absolute `offset`. */
function bigPage(count: number, offset = 0, hasNextPage = true) {
  return {
    data: {
      pages: [
        {
          offset,
          rows: Array.from({ length: count }, (_, i) => ({
            id: `big-${offset + i}`,
            locationId: 'parent',
          })),
        },
      ],
    },
    isLoading: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
    hasPreviousPage: offset > 0,
    isFetchingPreviousPage: false,
    fetchPreviousPage,
  };
}

/**
 * Give the DOM a real viewport for the duration of a test. happy-dom reports every element as
 * zero-sized, and a virtualizer over a zero-height scroller renders nothing at all — so the
 * virtualised-section tests below have to state how big the box is before they can assert what
 * lands in it. Restored by `vi.restoreAllMocks()` in the shared afterEach.
 */
function withViewport(width = 1000, height = 800) {
  // The virtualizer sizes its scroller from offsetWidth/offsetHeight, both hard-wired to 0 here.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
}

const node = (over: Partial<LocationTreeNode> & Pick<LocationTreeNode, 'id' | 'name'>): LocationTreeNode =>
  ({
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    icon: null,
    capacity: null,
    isDefault: false,
    archivedAt: null,
    updatedAt: 0,
    itemCount: 0,
    children: [],
    ...over,
  }) as LocationTreeNode;

const TREE: LocationTreeNode[] = [
  node({
    id: 'parent',
    name: 'Workshop',
    itemCount: 5,
    children: [node({ id: 'child', name: 'Shelf A', itemCount: 1 })],
  }),
  node({ id: 'empty', name: 'Garage', itemCount: 0 }),
];

const PROPS = {
  density: 'visual' as const,
  search: '',
  includeInactive: false,
  locations: [],
  locationName: (id: string) => id,
  cardFieldsConfig: {
    order: [] as string[],
    customFields: new Map(),
    categoryName: () => null,
    categoryGlyph: () => null,
    visibleCustomFieldIds: [] as string[],
  },
};

beforeEach(() => {
  sectionResult.clear();
  sectionResult.set('parent', page(['parent-a', 'parent-b'], true));
  sectionResult.set('child', page(['child-a']));
  sectionResult.set('empty', page([]));
  fetchNextPage.mockClear();
  fetchPreviousPage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GroupedItemList', () => {
  it('renders a section header per location, nesting children under their parent', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    expect(screen.getByTestId('location-section-header-parent')).toHaveTextContent('Workshop');
    expect(screen.getByTestId('location-section-header-child')).toHaveTextContent('Shelf A');
    expect(screen.getByTestId('location-section-header-empty')).toHaveTextContent('Garage');
  });

  it('expands top-level sections by default and shows their direct items', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    // The top-level "Workshop" section is open, so its two items render…
    expect(screen.getByText('parent-a')).toBeInTheDocument();
    expect(screen.getByText('parent-b')).toBeInTheDocument();
    // …but its nested child section is collapsed, so the child's item is hidden.
    expect(screen.queryByText('child-a')).not.toBeInTheDocument();
  });

  it("reveals a nested section's items only once it is expanded", () => {
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    fireEvent.click(screen.getByTestId('location-section-header-child'));
    expect(screen.getByText('child-a')).toBeInTheDocument();
  });

  it('shows a muted note for an expanded, empty leaf section', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    expect(screen.getByText(/no items here/i)).toBeInTheDocument();
  });

  it('pages in more items via "Show more"', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    fireEvent.click(screen.getByTestId('location-section-more-parent'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('collapses an open section, hiding its items', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    const header = screen.getByTestId('location-section-header-parent');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('parent-a')).not.toBeInTheDocument();
  });

  it('renders dense rows in data density', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} density="data" />);
    const section = screen.getByText('parent-a');
    expect(within(section.parentElement as HTMLElement).getAllByTestId('stub-row').length).toBeGreaterThan(0);
  });

  it('renders a spreadsheet table (header + table rows) in table density', () => {
    render(<GroupedItemList tree={TREE} {...PROPS} density="table" />);
    // The open "Workshop" section shows a table header and its items as table rows.
    expect(screen.getAllByTestId('stub-table-header').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('stub-table-row').map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['parent-a', 'parent-b']),
    );
    expect(screen.queryByTestId('stub-row')).toBeNull();
    expect(screen.queryByTestId('stub-card')).toBeNull();
  });

  it('mounts every card of a small section as plain DOM', () => {
    // Below the threshold nothing is virtualised — the section is exactly its items.
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    expect(screen.queryByTestId('location-section-virtual-body')).toBeNull();
    expect(screen.getAllByTestId('stub-card')).toHaveLength(2);
  });

  it('virtualises a section that has paged past its first page (issue #171)', () => {
    // 200 items in one location: the body switches to the virtualiser, so only the rows near
    // the viewport are mounted rather than 200 cards — each of which would carry its own
    // dialogs, mutations and thumbnail BLOB.
    withViewport();
    sectionResult.set('parent', bigPage(200));
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    expect(screen.getByTestId('location-section-virtual-body')).toBeInTheDocument();
    const mounted = screen.getAllByTestId('stub-card');
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(50);
    // What is mounted is the head of the section, not an arbitrary slice.
    expect(mounted[0]).toHaveTextContent('big-0');
  });

  it('virtualises in table density too, keeping one header above the virtual rows', () => {
    withViewport();
    sectionResult.set('parent', bigPage(200));
    render(<GroupedItemList tree={TREE} {...PROPS} density="table" />);
    expect(screen.getByTestId('location-section-virtual-body')).toBeInTheDocument();
    expect(screen.getAllByTestId('stub-table-header')).toHaveLength(1);
    const rows = screen.getAllByTestId('stub-table-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
  });

  // Issue #208: a grouped section is a list too, and its cards must say where they sit in it.
  it('declares each plain section a labelled list and numbers its cards', () => {
    // Fully loaded (no further page), so the section's own item count is the honest set size.
    sectionResult.set('parent', page(['parent-a', 'parent-b']));
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    const list = screen.getAllByRole('list', { name: 'Items in this location' })[0] as HTMLElement;
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((el) => [el.getAttribute('aria-posinset'), el.getAttribute('aria-setsize')]),
    ).toEqual([
      ['1', '2'],
      ['2', '2'],
    ]);
  });

  it('reports an unknown set size for a section that still has a page to load', () => {
    // The shared fixture leaves "Workshop" with a further page pending.
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    const list = screen.getAllByRole('list', { name: 'Items in this location' })[0] as HTMLElement;
    for (const el of within(list).getAllByRole('listitem')) {
      expect(el).toHaveAttribute('aria-setsize', '-1');
    }
  });

  it('declares a virtualised section a list, numbering its cards against the whole section', () => {
    withViewport();
    // 200 items with a further page pending: only a screenful is mounted, so each mounted card
    // has to carry its own absolute position and an unknown set size.
    sectionResult.set('parent', bigPage(200));
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    const list = screen.getAllByRole('list', { name: 'Items in this location' })[0] as HTMLElement;
    const mounted = within(list).getAllByRole('listitem');
    expect(mounted[0]).toHaveAttribute('aria-posinset', '1');
    expect(mounted[1]).toHaveAttribute('aria-posinset', '2');
    expect(mounted[0]).toHaveAttribute('aria-setsize', '-1');
  });

  it('keeps a trimmed-off front page addressable rather than renumbering the section', () => {
    // The query caps retained pages, so a deeply-paged section's window starts partway down.
    // Rows are indexed absolutely, so row 0 is still result 0 — the rows on screen do not jump
    // when a page is trimmed, and scrolling back up refills the prefix.
    withViewport();
    sectionResult.set('parent', bigPage(100, 100));
    render(<GroupedItemList tree={TREE} {...PROPS} />);
    expect(screen.getByTestId('location-section-virtual-body')).toBeInTheDocument();
    // The visible head of the list is above the resident window, so the prefix is refetched.
    expect(fetchPreviousPage).toHaveBeenCalled();
  });

  it('wraps each top-level section in a scroll-reveal (armed pending entrance) without gating its content', () => {
    // happy-dom exposes a (non-firing) IntersectionObserver and reports motion allowed, so the
    // reveal arms: each top-level section wrapper holds `opacity-0` until it scrolls into view.
    // Crucially the content is still fully in the DOM/accessible from first paint — the reveal
    // only toggles a presentation class, it never gates rendering. Nested subsections are not
    // wrapped (they animate on expand) and the virtualised flat list is never wrapped at all.
    const { container } = render(<GroupedItemList tree={TREE} {...PROPS} />);
    const box = container.querySelector('[data-testid="grouped-item-list"]') as HTMLElement;
    const topLevelWrappers = Array.from(box.children) as HTMLElement[];
    expect(topLevelWrappers).toHaveLength(TREE.length);
    for (const w of topLevelWrappers) expect(w).toHaveClass('opacity-0');
    // Content reads regardless of the pending reveal — the section header and its items are here.
    expect(screen.getByTestId('location-section-header-parent')).toBeInTheDocument();
    expect(screen.getByText('parent-a')).toBeInTheDocument();
  });

  it('under reduced motion renders sections fully visible — never held invisible by the reveal', () => {
    // Force the reduced-motion branch: the reveal must not arm, so no section is left at
    // opacity:0 waiting on an observer — the enhancement degrades to plain, visible content.
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const { container } = render(<GroupedItemList tree={TREE} {...PROPS} />);
      expect(container.querySelector('.opacity-0')).toBeNull();
      expect(screen.getByTestId('location-section-header-parent')).toBeInTheDocument();
      expect(screen.getByText('parent-a')).toBeInTheDocument();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});
