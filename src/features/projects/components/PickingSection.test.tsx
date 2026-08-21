import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PickLine, ProjectBomLine } from '@/db/repositories';
import { PickingSection } from './PickingSection';

// The picking hooks are mocked so the section renders without a DB/QueryClient. `pickData`
// is mutated per-test to drive the different worksheet states; `mutate` is the toggle spy.
const mutate = vi.fn();
const pickData = vi.hoisted(() => ({ rows: [] as PickLine[], isLoading: false }));
const setPickedState = vi.hoisted(() => ({ isPending: false }));
vi.mock('../projects', () => ({
  usePickList: () => ({ data: pickData.rows, isLoading: pickData.isLoading }),
  useSetPicked: () => ({ mutate, isPending: setPickedState.isPending }),
}));

function makeLine(overrides: Partial<ProjectBomLine> = {}): ProjectBomLine {
  return {
    id: 'l1',
    projectId: 'p1',
    itemId: 'i1',
    designator: null,
    mpn: null,
    manufacturer: null,
    description: 'Bolt',
    requiredQty: 4,
    reservedQty: 0,
    receivedQty: 0,
    picked: false,
    reservationStatus: 'NONE',
    procurementStatus: 'NONE',
    unitCostSnapshot: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderSection() {
  const onFinalise = vi.fn();
  const user = userEvent.setup();
  render(<PickingSection projectId="p1" onFinalise={onFinalise} />);
  return { onFinalise, user };
}

beforeEach(() => {
  mutate.mockClear();
  pickData.isLoading = false;
  pickData.rows = [];
  setPickedState.isPending = false;
});

describe('PickingSection (issue #121 location-aware picking)', () => {
  it('shows gathering progress and each line’s per-location breakdown', () => {
    pickData.rows = [
      {
        line: makeLine({ id: 'l1', description: 'Bolt', picked: true }),
        placements: [
          { locationId: 'g', locationName: 'Garage · Shelf B', quantity: 3 },
          { locationId: 'lf', locationName: 'Loft bin 4', quantity: 2 },
        ],
      },
      { line: makeLine({ id: 'l2', description: 'Nut', picked: false }), placements: [] },
    ];
    renderSection();

    expect(screen.getByTestId('pick-progress')).toHaveTextContent('1 of 2 gathered');
    expect(screen.getByText('3 in Garage · Shelf B, 2 in Loft bin 4')).toBeInTheDocument();
    // A matched line with no stock is flagged rather than left blank.
    expect(screen.getByText('Not in stock')).toBeInTheDocument();
  });

  it('toggles a line’s picked state through the checkbox', async () => {
    pickData.rows = [{ line: makeLine({ id: 'l1', description: 'Bolt', picked: false }), placements: [] }];
    const { user } = renderSection();

    await user.click(screen.getByTestId('pick-l1'));
    expect(mutate).toHaveBeenCalledWith({ lineId: 'l1', picked: true });
  });

  it('keeps every checkbox tappable while a tick is saving (issue #670)', async () => {
    // `useSetPicked` is optimistic, so nothing is disabled mid-write. Both taps of a
    // walk-the-list pair must reach the mutation, not be swallowed by a shared pending flag.
    pickData.rows = [
      { line: makeLine({ id: 'l1', description: 'Bolt', picked: false }), placements: [] },
      { line: makeLine({ id: 'l2', description: 'Nut', picked: false }), placements: [] },
    ];
    setPickedState.isPending = true;
    const { user } = renderSection();

    expect(screen.getByTestId('pick-l1')).toBeEnabled();
    await user.click(screen.getByTestId('pick-l1'));
    await user.click(screen.getByTestId('pick-l2'));
    expect(mutate).toHaveBeenNthCalledWith(1, { lineId: 'l1', picked: true });
    expect(mutate).toHaveBeenNthCalledWith(2, { lineId: 'l2', picked: true });
  });

  it('surfaces the finalise step once every line is gathered', async () => {
    pickData.rows = [
      { line: makeLine({ id: 'l1', picked: true }), placements: [] },
      { line: makeLine({ id: 'l2', picked: true }), placements: [] },
    ];
    const { onFinalise, user } = renderSection();

    expect(screen.getByText(/All parts gathered/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finalise' }));
    expect(onFinalise).toHaveBeenCalledTimes(1);
  });

  it('does not surface the finalise step while parts remain', () => {
    pickData.rows = [
      { line: makeLine({ id: 'l1', picked: true }), placements: [] },
      { line: makeLine({ id: 'l2', picked: false }), placements: [] },
    ];
    renderSection();
    expect(screen.queryByText(/All parts gathered/)).toBeNull();
  });

  it('shows an empty state when there is nothing to pick', () => {
    pickData.rows = [];
    renderSection();
    expect(screen.getByText(/No parts to pick yet/)).toBeInTheDocument();
  });
});
