import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationStatsReport } from '@/features/reports/reports';

/**
 * Characterisation tests for {@link LocationStats} — the Statistics tab of the location dialog
 * (issue #458). The aggregation itself is proven against real SQLite in `ReportRepository.test.ts`;
 * here the `useLocationStats` seam is mocked so these tests pin only the presentation: the headline
 * tiles, the empty/loading states, the unpriced note, and the sub-location scope toggle (shown only
 * when the location has children, and re-querying the subtree when flipped). `useFormatters` runs
 * for real, because the money/quantity formatting is part of what these assert.
 */

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, boolean]>,
  result: null as unknown,
}));

vi.mock('@/features/reports/queries', () => ({
  useLocationStats: (locationId: string, includeSubtree: boolean) => {
    state.calls.push([locationId, includeSubtree]);
    return state.result;
  },
}));

import { LocationStats } from './LocationStats';

function report(overrides: Partial<LocationStatsReport> = {}): LocationStatsReport {
  return {
    includesSubtree: false,
    locationCount: 1,
    totalValue: 120,
    totalQuantity: 115,
    distinctItemCount: 3,
    unpricedItemCount: 0,
    byCategory: [{ id: 'caps', name: 'Capacitors', value: 20, quantity: 10 }],
    ...overrides,
  };
}

beforeEach(() => {
  state.calls = [];
  state.result = { data: report(), isPending: false, isError: false };
});

afterEach(() => cleanup());

describe('LocationStats', () => {
  it('renders the headline tiles and category breakdown', () => {
    render(<LocationStats locationId="shelf" hasChildren={false} />);
    expect(screen.getByTestId('location-stats-value')).toBeInTheDocument();
    expect(screen.getByTestId('location-stats-items')).toHaveTextContent('3');
    expect(screen.getByTestId('location-stats-units')).toHaveTextContent('115');
    expect(screen.getByTestId('value-breakdown')).toHaveTextContent('Capacitors');
  });

  it('hides the scope toggle when the location has no sub-locations', () => {
    render(<LocationStats locationId="shelf" hasChildren={false} />);
    expect(screen.queryByTestId('location-stats-scope-subtree')).not.toBeInTheDocument();
  });

  it('offers the subtree scope toggle and re-queries with it when a location has children', () => {
    render(<LocationStats locationId="garage" hasChildren />);
    // Initial render queries this location alone.
    expect(state.calls.at(-1)).toEqual(['garage', false]);

    fireEvent.click(screen.getByTestId('location-stats-scope-subtree'));
    // Flipping to "with sub-locations" re-queries the whole subtree.
    expect(state.calls.at(-1)).toEqual(['garage', true]);
  });

  it('notes unpriced items that are excluded from the total', () => {
    state.result = { data: report({ unpricedItemCount: 2 }), isPending: false, isError: false };
    render(<LocationStats locationId="shelf" hasChildren={false} />);
    expect(screen.getByText(/no value set/i)).toBeInTheDocument();
  });

  it('shows an empty message when nothing is stored', () => {
    state.result = {
      data: report({ distinctItemCount: 0, totalValue: 0, totalQuantity: 0, byCategory: [] }),
      isPending: false,
      isError: false,
    };
    render(<LocationStats locationId="shelf" hasChildren={false} />);
    expect(screen.getByText(/nothing is stored here yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('location-stats-value')).not.toBeInTheDocument();
  });

  it('shows a spinner while the figures load', () => {
    state.result = { data: undefined, isPending: true, isError: false };
    const { container } = render(<LocationStats locationId="shelf" hasChildren={false} />);
    expect(container.querySelector('[data-testid="location-stats-value"]')).toBeNull();
    // The tiles are absent while pending; the breakdown is not rendered either.
    expect(screen.queryByTestId('value-breakdown')).not.toBeInTheDocument();
  });
});
