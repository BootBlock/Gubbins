import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ActivityFeedEntry, LocationHistoryEntry } from '@/db/repositories';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));
vi.mock('@/components/BrandTagline', () => ({ BrandTagline: () => <span data-testid="brand-tagline" /> }));
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <span data-testid="header-search" />,
}));
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ dateTime: () => '31 Jul 2026, 09:30' }),
}));

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care *which* export the screen offers, and whether it is live.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

// ─── controlled query stubs ───────────────────────────────────────────────────

interface QueryState<T> {
  isLoading: boolean;
  isError: boolean;
  rows: T[];
}

let itemState: QueryState<ActivityFeedEntry> = { isLoading: false, isError: false, rows: [] };
let locationState: QueryState<LocationHistoryEntry> = { isLoading: false, isError: false, rows: [] };
let itemCount = 0;
let locationCount = 0;

/** Which lane's hooks were actually *enabled*, and the filter each was given, per render. */
const enabledReads: string[] = [];
const itemActionsSeen: (readonly string[] | undefined)[] = [];
const locationActionsSeen: (readonly string[] | undefined)[] = [];
const pagesRequested: { lane: string; page: number }[] = [];

const infinite = <T,>(state: QueryState<T>, enabled: boolean) => ({
  data: enabled ? { pages: [{ rows: state.rows, offset: 0, limit: 50, hasMore: false }] } : undefined,
  isLoading: enabled ? state.isLoading : false,
  isError: enabled ? state.isError : false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  hasPreviousPage: false,
  isFetchingPreviousPage: false,
  fetchPreviousPage: vi.fn(),
});

vi.mock('./queries', () => ({
  readActivityFeedPage: vi.fn(() => vi.fn()),
  readLocationActivityFeedPage: vi.fn(() => vi.fn()),
  useActivityFeed: (actions: readonly string[] | undefined, enabled: boolean) => {
    if (enabled) enabledReads.push('items.feed');
    itemActionsSeen.push(actions);
    return infinite(itemState, enabled);
  },
  useActivityPage: (
    actions: readonly string[] | undefined,
    page: number,
    _size: number,
    enabled: boolean,
  ) => {
    if (enabled) {
      enabledReads.push('items.page');
      pagesRequested.push({ lane: 'items', page });
    }
    return {
      data: enabled ? { rows: itemState.rows, offset: 0, limit: 50, hasMore: false } : undefined,
      isLoading: enabled ? itemState.isLoading : false,
      isError: enabled ? itemState.isError : false,
    };
  },
  useActivityFeedCount: (_actions: readonly string[] | undefined, enabled: boolean) => {
    if (enabled) enabledReads.push('items.count');
    return { data: enabled ? itemCount : undefined };
  },
  useLocationActivityFeed: (actions: readonly string[] | undefined, enabled: boolean) => {
    if (enabled) enabledReads.push('locations.feed');
    locationActionsSeen.push(actions);
    return infinite(locationState, enabled);
  },
  useLocationActivityPage: (
    _actions: readonly string[] | undefined,
    page: number,
    _size: number,
    enabled: boolean,
  ) => {
    if (enabled) {
      enabledReads.push('locations.page');
      pagesRequested.push({ lane: 'locations', page });
    }
    return {
      data: enabled ? { rows: locationState.rows, offset: 0, limit: 50, hasMore: false } : undefined,
      isLoading: enabled ? locationState.isLoading : false,
      isError: enabled ? locationState.isError : false,
    };
  },
  useLocationActivityFeedCount: (_actions: readonly string[] | undefined, enabled: boolean) => {
    if (enabled) enabledReads.push('locations.count');
    return { data: enabled ? locationCount : undefined };
  },
}));

import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ActivityFeedScreen } from './ActivityFeedScreen';

const itemEntry = (id: string, itemName: string): ActivityFeedEntry => ({
  id,
  itemId: `i-${id}`,
  action: 'CREATED',
  quantityDelta: null,
  netValueDelta: null,
  note: null,
  metadata: null,
  createdAt: Date.parse('2026-07-31T09:30:00Z'),
  itemName,
  itemIsActive: true,
});

const locationEntry = (
  id: string,
  locationName: string,
  overrides: Partial<LocationHistoryEntry> = {},
): LocationHistoryEntry => ({
  id,
  locationId: `l-${id}`,
  locationName,
  action: 'RENAMED',
  note: `Renamed from "Old" to "${locationName}".`,
  metadata: null,
  actorUserId: 'user-admin',
  createdAt: Date.parse('2026-07-31T09:30:00Z'),
  ...overrides,
});

/** Move to the Locations lane the way a user does. */
const switchToLocations = () => fireEvent.click(screen.getByTestId('activity-lane-locations'));

beforeEach(() => {
  enabledReads.length = 0;
  itemActionsSeen.length = 0;
  locationActionsSeen.length = 0;
  pagesRequested.length = 0;
  itemState = { isLoading: false, isError: false, rows: [itemEntry('h1', 'Brass widget')] };
  locationState = { isLoading: false, isError: false, rows: [locationEntry('lh1', 'Top shelf')] };
  itemCount = 1;
  locationCount = 1;
  // Discrete pages, so the rows under test are plainly rendered rather than measured by the
  // virtualiser (which has no layout to measure in jsdom).
  usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 50 });
});
afterEach(cleanup);

/**
 * The Activity screen's two lanes (issue #693).
 *
 * The behaviours worth pinning are the ones the lane switch exists for: that a location's record
 * has an in-app reader at all, that it does not offer a route to a place that may no longer exist,
 * and that only the lane on screen reads — a second lane that quietly kept querying the first would
 * double every activity read for the whole app.
 */
describe('ActivityFeedScreen lanes (issue #693)', () => {
  it('starts on the Items lane and reads only it', () => {
    render(<ActivityFeedScreen />);

    expect(screen.getByTestId('activity-lane-items').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('activity-lane-locations').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('activity-feed-entry').textContent).toContain('Brass widget');
    expect(enabledReads.filter((r) => r.startsWith('locations.'))).toEqual([]);
  });

  it('shows the location record when switched, through the shared describe seam', () => {
    render(<ActivityFeedScreen />);
    switchToLocations();

    const row = screen.getByTestId('location-activity-feed-entry');
    expect(row.textContent).toContain('Top shelf');
    // "Renamed", not RENAMED — the same label the editor's History tab renders.
    expect(row.textContent).toContain('Renamed');
    expect(row.textContent).toContain('Renamed from "Old" to "Top shelf".');
    expect(screen.queryByTestId('activity-feed-entry')).toBeNull();
  });

  it('reads a deleted location’s entry — the case with no other reader', () => {
    locationState = {
      isLoading: false,
      isError: false,
      rows: [
        locationEntry('lh2', 'Top shelf', {
          action: 'DELETED',
          note: 'Deleted "Top shelf". 2 items were moved to Unassigned; 0 sub-locations were moved to the top level.',
        }),
      ],
    };
    render(<ActivityFeedScreen />);
    switchToLocations();

    const row = screen.getByTestId('location-activity-feed-entry');
    expect(row.textContent).toContain('Deleted');
    expect(row.textContent).toContain('moved to Unassigned');
  });

  it('never offers a link out of a location row', () => {
    // The entries this lane exists for are about places that no longer exist; a route to one
    // would be an invitation to nowhere. The item lane still links, so this is the lane's own rule.
    render(<ActivityFeedScreen />);
    const itemLinks = screen.getByTestId('activity-feed').querySelectorAll('a');
    expect(itemLinks.length).toBeGreaterThan(0);

    switchToLocations();
    expect(screen.getByTestId('location-activity-feed').querySelectorAll('a')).toHaveLength(0);
  });

  it('leaves the lane that is off screen idle', () => {
    render(<ActivityFeedScreen />);
    enabledReads.length = 0;
    switchToLocations();

    expect(enabledReads.filter((r) => r.startsWith('items.'))).toEqual([]);
    expect(enabledReads).toContain('locations.page');
    expect(enabledReads).toContain('locations.count');
  });

  it('filters the location lane by its own action vocabulary', () => {
    render(<ActivityFeedScreen />);
    switchToLocations();
    // Every chip enabled = no filter, so the repository skips the WHERE clause entirely.
    expect(locationActionsSeen.at(-1)).toBeUndefined();

    fireEvent.click(screen.getByTestId('location-activity-filter-DELETED'));
    // Deselecting one action narrows to the rest — location actions, not item history actions.
    const actions = locationActionsSeen.at(-1);
    expect(actions).toBeDefined();
    expect(actions).not.toContain('DELETED');
    expect(actions).toContain('RENAMED');
    expect(actions).toContain('RE_PARENTED');
  });

  it('keeps each lane’s filter selection when switching away and back', () => {
    render(<ActivityFeedScreen />);
    fireEvent.click(screen.getByTestId('activity-filter-loan'));
    const narrowedItems = itemActionsSeen.at(-1);
    expect(narrowedItems).toBeDefined();

    switchToLocations();
    fireEvent.click(screen.getByTestId('activity-lane-items'));

    expect(screen.getByTestId('activity-filter-loan').getAttribute('aria-pressed')).toBe('false');
    expect(itemActionsSeen.at(-1)).toEqual(narrowedItems);
  });

  it('offers the lane’s own export, not the item one', () => {
    render(<ActivityFeedScreen />);
    expect(screen.getByTestId('export-activity')).toBeTruthy();

    switchToLocations();
    expect(screen.queryByTestId('export-activity')).toBeNull();
    expect(screen.getByTestId('export-location-activity')).toBeTruthy();
  });

  it('disables the export when the lane it would read is empty', () => {
    locationState = { isLoading: false, isError: false, rows: [] };
    render(<ActivityFeedScreen />);
    switchToLocations();

    expect(screen.getByTestId('export-location-activity').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('No activity to show')).toBeTruthy();
  });

  it('resets to page 1 when the lane changes, so a shorter ledger can’t strand the reader', () => {
    // Enough item events for a second page; the location ledger has one page only.
    itemCount = 120;
    render(<ActivityFeedScreen />);
    fireEvent.click(screen.getByTestId('activity-feed-pagination-next'));
    expect(pagesRequested.filter((p) => p.lane === 'items').at(-1)?.page).toBe(2);

    switchToLocations();
    expect(pagesRequested.filter((p) => p.lane === 'locations').at(-1)?.page).toBe(1);
  });

  it('re-announces the count for the lane now on screen', () => {
    locationState = {
      isLoading: false,
      isError: false,
      rows: [locationEntry('a', 'Shelf'), locationEntry('b', 'Bin')],
    };
    render(<ActivityFeedScreen />);
    expect(screen.getByTestId('activity-live-region').textContent).toBe('Showing 1 recent event.');

    switchToLocations();
    expect(screen.getByTestId('activity-live-region').textContent).toBe('Showing 2 recent events.');
  });

  it('reports a failed load on the lane rather than its empty state', () => {
    locationState = { isLoading: false, isError: true, rows: [] };
    render(<ActivityFeedScreen />);
    switchToLocations();

    expect(screen.getByText('Failed to load activity. Please refresh the page.')).toBeTruthy();
    expect(screen.queryByText('No activity to show')).toBeNull();
  });
});
