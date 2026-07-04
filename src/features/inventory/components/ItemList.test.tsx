import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { IN_TRANSIT_LOCATION_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { ItemList } from './ItemList';

function loc(id: string, name: string, parentId: string | null): LocationWithCount {
  return {
    id,
    name,
    parentId,
    isSystem: false,
    description: null,
    color: null,
    kind: null,
    capacity: null,
    isDefault: false,
    archivedAt: null,
    updatedAt: 0,
    itemCount: 0,
  };
}

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
  cardFields: {
    order: [] as string[],
    customFields: new Map(),
    categoryName: () => null,
    values: undefined,
  },
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

  it('drills into child locations instead of the empty banner when a location nests them', () => {
    const onSelectLocation = vi.fn();
    render(
      <ItemList
        {...BASE_PROPS}
        selectedLocationId="shed"
        childLocations={[loc('a', 'Cabinet A', 'shed'), loc('b', 'Cabinet B', 'shed')]}
        onSelectLocation={onSelectLocation}
      />,
    );
    expect(screen.queryByText('No items here yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open Cabinet A/i }));
    expect(onSelectLocation).toHaveBeenCalledWith('a');
  });

  it('still shows the empty banner when the location has no child locations', () => {
    render(
      <ItemList {...BASE_PROPS} selectedLocationId="shed" childLocations={[]} onSelectLocation={() => {}} />,
    );
    expect(screen.getByText('No items here yet')).toBeInTheDocument();
  });
});
