import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Item } from '@/db/repositories';
import type { ItemAvailability, ReservationClaim } from '@/features/projects/reservations';

/**
 * The item side of project reservations (issue #653): what is free, who holds the rest, and the
 * over-commitment alert that is the whole point of the panel. The allocation maths is the pure
 * `features/projects/reservations` seam (covered by its own tests); this pins what the panel
 * *renders* for a given answer. Per the component-test conventions the read hook is mocked.
 */
const h = vi.hoisted(() => ({
  availability: undefined as ItemAvailability | undefined,
  isLoading: false,
}));

vi.mock('../queries', () => ({
  useItemAvailability: () => ({ data: h.availability, isLoading: h.isLoading }),
}));

import { ItemReservationsPanel } from './ItemReservationsPanel';

// The panel reads nothing but the id; the rest of the row is irrelevant to what it renders.
const ITEM = { id: 'item-1' } as Item;

function claim(overrides: Partial<ReservationClaim> = {}): ReservationClaim {
  return {
    lineId: 'line-1',
    itemId: 'item-1',
    projectId: 'project-1',
    projectName: 'Weather station',
    status: 'ACTUAL',
    reservedQty: 2,
    createdAt: 0,
    ...overrides,
  };
}

function availability(overrides: Partial<ItemAvailability> = {}): ItemAvailability {
  return {
    itemId: 'item-1',
    onHandQty: 10,
    isUnlimited: false,
    actualQty: 0,
    tentativeQty: 0,
    reservedQty: 0,
    availableQty: 10,
    overCommittedQty: 0,
    backingByLine: new Map(),
    claims: [],
    ...overrides,
  };
}

beforeEach(() => {
  h.availability = undefined;
  h.isLoading = false;
});
afterEach(cleanup);

describe('ItemReservationsPanel (issue #653)', () => {
  it('reports an unclaimed item as fully available', () => {
    h.availability = availability();
    render(<ItemReservationsPanel item={ITEM} />);

    expect(screen.getByText('10 in stock')).toBeInTheDocument();
    expect(screen.getByText('10 available')).toBeInTheDocument();
    expect(screen.getByText('No open project has reserved any of this item.')).toBeInTheDocument();
  });

  it('names each project holding stock, and how much of its claim is real', () => {
    h.availability = availability({
      reservedQty: 6,
      actualQty: 6,
      availableQty: 4,
      claims: [claim({ reservedQty: 6 })],
      backingByLine: new Map([['line-1', { lineId: 'line-1', backedQty: 6, unbackedQty: 0 }]]),
    });
    render(<ItemReservationsPanel item={ITEM} />);

    expect(screen.getByText('Weather station')).toBeInTheDocument();
    expect(screen.getByText('Firm')).toBeInTheDocument();
    expect(screen.getByText('6 held')).toBeInTheDocument();
    expect(screen.queryByTestId('item-over-committed')).toBeNull();
  });

  it('raises an alert when more is claimed than exists, and marks the claim that lost out', () => {
    h.availability = availability({
      onHandQty: 10,
      reservedQty: 15,
      actualQty: 15,
      availableQty: 0,
      overCommittedQty: 5,
      claims: [claim({ reservedQty: 9, projectName: 'Second' })],
      backingByLine: new Map([['line-1', { lineId: 'line-1', backedQty: 4, unbackedQty: 5 }]]),
    });
    render(<ItemReservationsPanel item={ITEM} />);

    const alert = screen.getByTestId('item-over-committed');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('5 reserved units have no stock behind them');
    expect(screen.getByText('5 unbacked')).toBeInTheDocument();
  });

  it('says a claim on an unlimited-supply item can never run it short', () => {
    h.availability = availability({ isUnlimited: true, reservedQty: 500, claims: [claim()] });
    render(<ItemReservationsPanel item={ITEM} />);

    expect(
      screen.getByText('This item has an unlimited supply, so a reservation can never run it short.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('item-over-committed')).toBeNull();
  });

  it('renders nothing for an id that matches no item, rather than a confident zero', () => {
    h.availability = undefined;
    const { container } = render(<ItemReservationsPanel item={ITEM} />);

    expect(container).toBeEmptyDOMElement();
  });
});
