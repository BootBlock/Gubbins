import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { LocationInfoCard } from './LocationInfoCard';

/**
 * The compact per-location summary shown atop the inventory list. Drives the real formatters
 * (en-GB defaults), so it also covers that the item count, capacity and fullness percent are
 * rendered as the user would see them. Responsive shedding is CSS-only (breakpoint `hidden`
 * utilities), so it isn't exercised here — jsdom keeps every piece in the DOM.
 */

const parent: LocationWithCount = {
  id: 'root',
  name: 'Workshop',
  parentId: null,
  isSystem: false,
  description: null,
  color: null,
  kind: 'room',
  capacity: null,
  isDefault: false,
  archivedAt: null,
  updatedAt: 1_700_000_000_000,
  itemCount: 0,
};

function makeLocation(overrides: Partial<LocationWithCount> = {}): LocationWithCount {
  return {
    id: 'l1',
    name: 'Cabinet A',
    parentId: 'root',
    isSystem: false,
    description: null,
    color: null,
    kind: 'cabinet',
    capacity: 50,
    isDefault: false,
    archivedAt: null,
    updatedAt: 1_700_000_000_000,
    itemCount: 30,
    ...overrides,
  };
}

afterEach(cleanup);

describe('LocationInfoCard', () => {
  it('shows the name, item count against capacity and the fullness percent', () => {
    const location = makeLocation();
    render(<LocationInfoCard location={location} locations={[parent, location]} onHide={() => {}} />);

    expect(screen.getByTestId('location-info-card')).toHaveTextContent('Cabinet A');
    expect(screen.getByTestId('location-info-card')).toHaveTextContent('30 / 50');
    // 30 of 50 → 60% full.
    expect(screen.getByTestId('location-info-fullness')).toHaveTextContent('60%');
  });

  it('shows the breadcrumb path, but omits it for a root location', () => {
    const nested = makeLocation();
    const { rerender } = render(
      <LocationInfoCard location={nested} locations={[parent, nested]} onHide={() => {}} />,
    );
    expect(screen.getByText('Workshop / Cabinet A')).toBeInTheDocument();

    // A root location's path is just its own name — not repeated beside it.
    const root = makeLocation({ id: 'root2', name: 'Garage', parentId: null });
    rerender(<LocationInfoCard location={root} locations={[root]} onHide={() => {}} />);
    expect(screen.queryByText('Garage / Garage')).not.toBeInTheDocument();
  });

  it('drops the fullness gauge for a location with no capacity', () => {
    const location = makeLocation({ capacity: null, itemCount: 7 });
    render(<LocationInfoCard location={location} locations={[parent, location]} onHide={() => {}} />);

    expect(screen.queryByTestId('location-info-fullness')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-info-card')).toHaveTextContent('7');
  });

  it('calls onHide when the dismiss control is used', () => {
    const onHide = vi.fn();
    const location = makeLocation();
    render(<LocationInfoCard location={location} locations={[parent, location]} onHide={onHide} />);

    fireEvent.click(screen.getByTestId('location-info-hide'));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
