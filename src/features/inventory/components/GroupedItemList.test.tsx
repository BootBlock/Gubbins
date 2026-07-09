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

const { sectionResult, fetchNextPage } = vi.hoisted(() => ({
  // Per-location fake query results, keyed by the section's location id.
  sectionResult: new Map<string, unknown>(),
  fetchNextPage: vi.fn(),
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

vi.mock('./ItemCard', () => ({
  ItemCard: ({ item }: { item: { id: string } }) => <div data-testid="stub-card">{item.id}</div>,
}));
vi.mock('./ItemRow', () => ({
  ItemRow: ({ item }: { item: { id: string } }) => <div data-testid="stub-row">{item.id}</div>,
}));
// Each section fetches its own on-screen custom-field values (E1); the default config shows
// no custom field, so the query is disabled — stub it so no QueryClient is needed here.
vi.mock('../categories', () => ({
  useItemFieldValues: () => ({ data: undefined }),
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

const node = (over: Partial<LocationTreeNode> & Pick<LocationTreeNode, 'id' | 'name'>): LocationTreeNode =>
  ({
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    kind: null,
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
    hasCustomFields: false,
  },
};

beforeEach(() => {
  sectionResult.clear();
  sectionResult.set('parent', page(['parent-a', 'parent-b'], true));
  sectionResult.set('child', page(['child-a']));
  sectionResult.set('empty', page([]));
  fetchNextPage.mockClear();
});
afterEach(cleanup);

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
