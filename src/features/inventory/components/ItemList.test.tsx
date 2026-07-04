import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { IN_TRANSIT_LOCATION_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { ItemList } from './ItemList';

/**
 * Empty-state coverage for {@link ItemList}. With no items the list short-circuits to
 * its banner before the virtualizer touches the DOM, so this exercises the system-location
 * hints shown for In Transit / Unassigned (the "explain the liminal location" behaviour)
 * without any of the paging machinery.
 */

const BASE_PROPS = {
  items: [],
  firstItemIndex: 0,
  locations: [],
  density: 'visual' as const,
  locationName: (id: string) => id,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: () => {},
  hasPreviousPage: false,
  isFetchingPreviousPage: false,
  fetchPreviousPage: () => {},
};

afterEach(cleanup);

describe('ItemList empty state', () => {
  it('shows the generic add-your-first-item copy for a normal location', () => {
    render(<ItemList {...BASE_PROPS} selectedLocationId="loc-1" />);
    expect(screen.getByText('No items here yet')).toBeInTheDocument();
    expect(screen.getByText(/add your first item to start tracking/i)).toBeInTheDocument();
  });

  it('explains the In Transit location when it is empty', () => {
    render(<ItemList {...BASE_PROPS} selectedLocationId={IN_TRANSIT_LOCATION_ID} />);
    expect(screen.getByText('No items here yet')).toBeInTheDocument();
    expect(screen.getByText(/incoming stock waits before it arrives/i)).toBeInTheDocument();
    expect(screen.queryByText(/add your first item/i)).not.toBeInTheDocument();
  });

  it('explains the Unassigned location when it is empty', () => {
    render(<ItemList {...BASE_PROPS} selectedLocationId={UNASSIGNED_LOCATION_ID} />);
    expect(screen.getByText('No items here yet')).toBeInTheDocument();
    expect(screen.getByText(/don't have a location yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/add your first item/i)).not.toBeInTheDocument();
  });
});
