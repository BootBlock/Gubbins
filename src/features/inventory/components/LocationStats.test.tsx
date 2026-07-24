import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import type { LocationStatsReport } from '@/features/reports/reports';

/**
 * Characterisation tests for {@link LocationStats} — the Statistics tab of the location dialog
 * (issue #458, extended with volumetric stats for #457). The aggregation itself is proven against
 * real SQLite in `ReportRepository.test.ts`; here the `useLocationStats` seam is mocked so these
 * tests pin only the presentation: the headline tiles (value/items/units/space-used), the
 * volume-utilisation note, the empty/loading states, the unpriced + unmeasured notes, and the
 * sub-location scope toggle (shown only when the location has children, and re-querying the subtree
 * when flipped). `useFormatters` and the pure volume seams run for real, because the volume
 * formatting and utilisation maths are part of what these assert.
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
    usedVolume: 3_000_000, // 3 L
    measuredItemCount: 3,
    byCategory: [{ id: 'caps', name: 'Capacitors', value: 20, quantity: 10 }],
    ...overrides,
  };
}

/**
 * A minimal location fixture — the component reads only `id` and the dimension fields (which give
 * the location its own volume capacity). Tests are excluded from tsc, so a partial cast is fine.
 * The default has a 10 cm cube of internal size (1,000,000 mm³) so it carries a volume capacity.
 */
function loc(overrides: Partial<LocationWithCount> = {}): LocationWithCount {
  return {
    id: 'garage',
    width: 100,
    height: 100,
    depth: 100,
    usableVolume: null,
    packingFactor: null,
    ...overrides,
  } as unknown as LocationWithCount;
}

beforeEach(() => {
  state.calls = [];
  state.result = { data: report(), isPending: false, isError: false };
});

afterEach(() => cleanup());

describe('LocationStats', () => {
  it('renders the headline tiles and category breakdown', () => {
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.getByTestId('location-stats-value')).toBeInTheDocument();
    expect(screen.getByTestId('location-stats-items')).toHaveTextContent('3');
    expect(screen.getByTestId('location-stats-units')).toHaveTextContent('115');
    expect(screen.getByTestId('value-breakdown')).toHaveTextContent('Capacitors');
  });

  it('shows the space-used tile and the volume-utilisation note against the location capacity', () => {
    render(<LocationStats location={loc()} hasChildren={false} />);
    // 3,000,000 mm³ used against a 1,000,000 mm³ capacity → a real volume figure, over 100%.
    const volume = screen.getByTestId('location-stats-volume');
    expect(volume).toBeInTheDocument();
    expect(volume.textContent).not.toBe('—');
    expect(screen.getByText(/% of/)).toBeInTheDocument();
  });

  it('shows a dash for space used and no utilisation when nothing is measured', () => {
    state.result = {
      data: report({ usedVolume: 0, measuredItemCount: 0 }),
      isPending: false,
      isError: false,
    };
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.getByTestId('location-stats-volume')).toHaveTextContent('—');
    expect(screen.queryByText(/% of/)).not.toBeInTheDocument();
  });

  it('notes when some items are unmeasured, so space used is understood to be partial', () => {
    state.result = {
      data: report({ distinctItemCount: 5, measuredItemCount: 3 }),
      isPending: false,
      isError: false,
    };
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.getByTestId('location-stats-unmeasured')).toHaveTextContent('3 of 5');
  });

  it('hides the scope toggle when the location has no sub-locations', () => {
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.queryByTestId('location-stats-scope-subtree')).not.toBeInTheDocument();
  });

  it('offers the subtree scope toggle and re-queries with it when a location has children', () => {
    render(<LocationStats location={loc()} hasChildren />);
    // Initial render queries this location alone.
    expect(state.calls.at(-1)).toEqual(['garage', false]);

    fireEvent.click(screen.getByTestId('location-stats-scope-subtree'));
    // Flipping to "with sub-locations" re-queries the whole subtree.
    expect(state.calls.at(-1)).toEqual(['garage', true]);
    // The self-only utilisation note is withdrawn once the scope covers the subtree.
    expect(screen.queryByText(/% of/)).not.toBeInTheDocument();
  });

  it('notes unpriced items that are excluded from the total', () => {
    state.result = { data: report({ unpricedItemCount: 2 }), isPending: false, isError: false };
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.getByText(/no value set/i)).toBeInTheDocument();
  });

  it('shows an empty message when nothing is stored', () => {
    state.result = {
      data: report({ distinctItemCount: 0, totalValue: 0, totalQuantity: 0, byCategory: [] }),
      isPending: false,
      isError: false,
    };
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.getByText(/nothing is stored here yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('location-stats-value')).not.toBeInTheDocument();
  });

  it('shows a spinner while the figures load', () => {
    state.result = { data: undefined, isPending: true, isError: false };
    render(<LocationStats location={loc()} hasChildren={false} />);
    expect(screen.queryByTestId('location-stats-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('value-breakdown')).not.toBeInTheDocument();
  });
});
