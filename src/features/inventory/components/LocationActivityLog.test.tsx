import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationHistoryEntry } from '@/db/repositories';

/**
 * The location editor's History tab (issue #691).
 *
 * What this pins is the panel's own contract — that an entry reads as its action plus the note
 * the repository wrote, that an empty record says so rather than showing a bare frame, and that
 * more pages are only offered when there are more. The repository and query seams are mocked per
 * the component-test conventions: a component test has no QueryClient or worker.
 */

const h = vi.hoisted(() => ({
  entries: [] as LocationHistoryEntry[],
  isLoading: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
}));

vi.mock('../queries', () => ({
  useLocationHistory: () => ({
    data: { pages: [{ rows: h.entries, offset: 0 }] },
    isLoading: h.isLoading,
    hasNextPage: h.hasNextPage,
    isFetchingNextPage: h.isFetchingNextPage,
    fetchNextPage: h.fetchNextPage,
  }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ dateTime: (ms: number) => `at ${ms}` }),
}));

import { LocationActivityLog } from './LocationActivityLog';

function entry(overrides: Partial<LocationHistoryEntry> & { id: string }): LocationHistoryEntry {
  return {
    locationId: 'loc-1',
    locationName: 'Shelf B',
    action: 'RENAMED',
    note: 'Renamed from "Shelf A" to "Shelf B".',
    metadata: null,
    actorUserId: 'user-1',
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as LocationHistoryEntry;
}

beforeEach(() => {
  h.entries = [];
  h.isLoading = false;
  h.hasNextPage = false;
  h.isFetchingNextPage = false;
  h.fetchNextPage = vi.fn();
});

afterEach(cleanup);

describe('LocationActivityLog', () => {
  it('says the record is empty rather than rendering an empty frame', () => {
    render(<LocationActivityLog locationId="loc-1" />);

    expect(screen.queryByTestId('location-activity-log')).toBeNull();
    expect(screen.getByText(/Nothing has been changed here yet/)).toBeTruthy();
  });

  it('renders each entry as its action title and stored note', () => {
    h.entries = [
      entry({ id: 'a' }),
      entry({ id: 'b', action: 'RE_PARENTED', note: 'Moved from "Workshop" to the top level.' }),
    ];

    render(<LocationActivityLog locationId="loc-1" />);

    expect(screen.getAllByTestId('location-activity-entry')).toHaveLength(2);
    expect(screen.getByText('Renamed')).toBeTruthy();
    expect(screen.getByText('Moved')).toBeTruthy();
    expect(screen.getByText('Moved from "Workshop" to the top level.')).toBeTruthy();
  });

  it('omits the note line entirely when an entry has none', () => {
    h.entries = [entry({ id: 'a', action: 'ARCHIVED', note: null })];

    const { container } = render(<LocationActivityLog locationId="loc-1" />);

    expect(screen.getByText('Archived')).toBeTruthy();
    expect(container.querySelector('p')).toBeNull();
  });

  it('offers another page only when there is one, and asks for it on click', () => {
    h.entries = [entry({ id: 'a' })];
    const { unmount } = render(<LocationActivityLog locationId="loc-1" />);
    expect(screen.queryByTestId('location-activity-load-more')).toBeNull();
    unmount();

    h.hasNextPage = true;
    render(<LocationActivityLog locationId="loc-1" />);
    fireEvent.click(screen.getByTestId('location-activity-load-more'));
    expect(h.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
