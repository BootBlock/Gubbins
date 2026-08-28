import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectBomLine, TrackingMode } from '@/db/repositories';
import type { ItemAvailability } from '@/features/projects/reservations';

/**
 * Behaviour tests for the {@link BomLineTable}'s two advisory flags and its in-flight guard.
 *
 * Stock availability (issue #653): how much of a matched part nothing has claimed, and the flag
 * on a reservation no stock actually backs. The allocation maths is the pure
 * `features/projects/reservations` seam (covered by its own tests); here we pin what the table
 * renders for a given answer.
 *
 * Hard dependencies (issue #70). A BOM line whose
 * item `REQUIRES` something no *other* line covers is marked, so a bill of materials that would
 * build into an unusable assembly says so before it is picked. The set arithmetic lives in the
 * pure `item-requirements` seam (covered by its own tests); this pins the *table's* contract —
 * when the flag appears, and that it names the gap. Per the component-test conventions every hook
 * the table reads is mocked.
 */

const h = vi.hoisted(() => ({
  /** Relations keyed by item id, as the batched repository read returns them. */
  relationsByItem: new Map<
    string,
    { id: string; fromItemId: string; toItemId: string; kind: string; otherItemName: string }[]
  >(),
  /**
   * Per-mutation in-flight state, so the guard can be driven one action at a time (issue #303)
   * — a shared flag would let a control wired to the *wrong* mutation still pass. `variables`
   * mirrors what TanStack exposes for the in-flight call, which is how the table decides which
   * row shows the wait.
   */
  receive: { isPending: false, variables: undefined as { lineId: string } | undefined },
  remove: { isPending: false, variables: undefined as string | undefined },
  reservationPending: false,
  procurementPending: false,
  receiveMutate: vi.fn(),
  removeMutate: vi.fn(),
  /** Stock availability per matched item (issue #653); undefined = the read has not landed. */
  availabilityByItem: undefined as Map<string, ItemAvailability> | undefined,
  /** Tracking mode per matched item (issue #608); undefined = the read has not landed. */
  trackingModeByItem: undefined as Map<string, TrackingMode> | undefined,
}));

vi.mock('../projects', () => ({
  useRemoveBomLine: () => ({ mutate: h.removeMutate, ...h.remove }),
  useSetProcurement: () => ({ mutate: vi.fn(), isPending: h.procurementPending }),
  useSetReservation: () => ({ mutate: vi.fn(), isPending: h.reservationPending }),
  useReceiveLine: () => ({ mutate: h.receiveMutate, ...h.receive }),
}));
vi.mock('@/features/inventory/queries', () => ({
  useItemsRelations: () => ({ data: h.relationsByItem }),
  useItemsAvailability: () => ({ data: h.availabilityByItem }),
  useItemsTrackingModes: () => ({ data: h.trackingModeByItem }),
}));

import { BomLineTable } from './BomLineTable';

function makeLine(overrides: Partial<ProjectBomLine> = {}): ProjectBomLine {
  return {
    id: 'line-1',
    projectId: 'proj-1',
    itemId: 'ap',
    designator: null,
    mpn: null,
    manufacturer: null,
    description: 'Access point',
    requiredQty: 1,
    reservedQty: 0,
    receivedQty: 0,
    picked: false,
    reservationStatus: 'TENTATIVE',
    procurementStatus: 'NONE',
    unitCostSnapshot: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as ProjectBomLine;
}

/** `ap` requires `injector`, as the batched read would report it for the access point. */
function apRequiresInjector() {
  h.relationsByItem = new Map([
    [
      'ap',
      [
        {
          id: 'rel-1',
          fromItemId: 'ap',
          toItemId: 'injector',
          kind: 'REQUIRES',
          otherItemName: '48V PoE injector',
        },
      ],
    ],
  ]);
}

/**
 * Availability for the access point, as the batched read would return it (issue #653). The
 * per-line backing is what decides whether the table flags the reservation.
 */
function availability(overrides: Partial<ItemAvailability> = {}, backing = new Map()) {
  h.availabilityByItem = new Map<string, ItemAvailability>([
    [
      'ap',
      {
        itemId: 'ap',
        onHandQty: 10,
        isUnlimited: false,
        actualQty: 0,
        tentativeQty: 0,
        reservedQty: 0,
        availableQty: 10,
        overCommittedQty: 0,
        backingByLine: backing,
        claims: [],
        ...overrides,
      },
    ],
  ]);
}

beforeEach(() => {
  h.relationsByItem = new Map();
  h.availabilityByItem = undefined;
  h.trackingModeByItem = undefined;
  h.receive = { isPending: false, variables: undefined };
  h.remove = { isPending: false, variables: undefined };
  h.reservationPending = false;
  h.procurementPending = false;
  h.receiveMutate.mockClear();
  h.removeMutate.mockClear();
});
afterEach(cleanup);

describe('BomLineTable — stock availability (issue #653)', () => {
  it('shows how much of a matched part nothing has claimed', () => {
    availability({ onHandQty: 10, reservedQty: 4, availableQty: 6 });
    render(<BomLineTable projectId="proj-1" lines={[makeLine()]} />);

    expect(screen.getByTestId('bom-available-line-1')).toHaveTextContent('6 available');
  });

  it('shows no availability until the batched read lands', () => {
    render(<BomLineTable projectId="proj-1" lines={[makeLine()]} />);

    expect(screen.queryByTestId('bom-available-line-1')).toBeNull();
  });

  it('shows no availability for an unlimited-supply part, which can never run short', () => {
    availability({ isUnlimited: true });
    render(<BomLineTable projectId="proj-1" lines={[makeLine()]} />);

    expect(screen.queryByTestId('bom-available-line-1')).toBeNull();
  });

  it('flags a reservation another project’s claim beat to the stock', () => {
    availability(
      { onHandQty: 4, reservedQty: 10, availableQty: 0, overCommittedQty: 6 },
      new Map([['line-1', { lineId: 'line-1', backedQty: 2, unbackedQty: 4 }]]),
    );
    render(<BomLineTable projectId="proj-1" lines={[makeLine({ reservedQty: 6, requiredQty: 6 })]} />);

    expect(screen.getByTestId('bom-unbacked-reservation-line-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Reservation not backed by stock')).toBeInTheDocument();
  });

  it('does not flag a reservation real stock backs in full', () => {
    availability(
      { onHandQty: 10, reservedQty: 6, availableQty: 4 },
      new Map([['line-1', { lineId: 'line-1', backedQty: 6, unbackedQty: 0 }]]),
    );
    render(<BomLineTable projectId="proj-1" lines={[makeLine({ reservedQty: 6, requiredQty: 6 })]} />);

    expect(screen.queryByTestId('bom-unbacked-reservation-line-1')).toBeNull();
  });

  it('shows nothing for an unmatched line, which has no item to be available of', () => {
    availability();
    render(<BomLineTable projectId="proj-1" lines={[makeLine({ itemId: null })]} />);

    expect(screen.queryByTestId('bom-available-line-1')).toBeNull();
    expect(screen.queryByTestId('bom-unbacked-reservation-line-1')).toBeNull();
  });
});

describe('BomLineTable — hard-dependency flag (issue #70)', () => {
  it('flags a line whose prerequisite is missing from the BOM, naming the gap', () => {
    apRequiresInjector();
    render(<BomLineTable projectId="proj-1" lines={[makeLine()]} />);

    expect(screen.getByTestId('bom-missing-requirement-line-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Missing prerequisite — requires 48V PoE injector')).toBeInTheDocument();
  });

  it('does not flag when another line already covers the prerequisite', () => {
    apRequiresInjector();
    h.relationsByItem.set('injector', [
      {
        id: 'rel-1',
        fromItemId: 'ap',
        toItemId: 'injector',
        kind: 'REQUIRES',
        otherItemName: 'Access point',
      },
    ]);
    render(
      <BomLineTable
        projectId="proj-1"
        lines={[makeLine(), makeLine({ id: 'line-2', itemId: 'injector', description: 'Injector' })]}
      />,
    );

    expect(screen.queryByTestId('bom-missing-requirement-line-1')).toBeNull();
    expect(screen.queryByTestId('bom-missing-requirement-line-2')).toBeNull();
  });

  it('does not flag an advisory relation', () => {
    h.relationsByItem = new Map([
      [
        'ap',
        [
          {
            id: 'rel-1',
            fromItemId: 'ap',
            toItemId: 'tripod',
            kind: 'WORKS_WITH',
            otherItemName: 'Tripod',
          },
        ],
      ],
    ]);
    render(<BomLineTable projectId="proj-1" lines={[makeLine()]} />);
    expect(screen.queryByTestId('bom-missing-requirement-line-1')).toBeNull();
  });

  it('does not flag the "required by" end — the injector line is fine on its own', () => {
    h.relationsByItem = new Map([
      [
        'injector',
        [
          {
            id: 'rel-1',
            fromItemId: 'ap',
            toItemId: 'injector',
            kind: 'REQUIRES',
            otherItemName: 'Access point',
          },
        ],
      ],
    ]);
    render(
      <BomLineTable
        projectId="proj-1"
        lines={[makeLine({ id: 'line-2', itemId: 'injector', description: 'Injector' })]}
      />,
    );
    expect(screen.queryByTestId('bom-missing-requirement-line-2')).toBeNull();
  });

  it('leaves an unmatched (item-less) line unflagged', () => {
    apRequiresInjector();
    render(
      <BomLineTable
        projectId="proj-1"
        lines={[makeLine({ id: 'line-3', itemId: null, description: 'Loose part' })]}
      />,
    );
    expect(screen.queryByTestId('bom-missing-requirement-line-3')).toBeNull();
  });
});

/**
 * The in-flight guard (issue #303). Receiving is the consequential action — a second click
 * before the first receipt settles books the arriving quantity into stock twice — so every
 * row action locks while its mutation is in flight rather than reasoning per-action.
 */
describe('BomLineTable — in-flight guard (issue #303)', () => {
  const inTransit = (id = 'line-1') => makeLine({ id, procurementStatus: 'IN_TRANSIT', requiredQty: 5 });

  it('leaves the row actions live when nothing is in flight', async () => {
    const user = userEvent.setup();
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);

    expect(screen.getByLabelText('Receive into stock')).toBeEnabled();
    expect(screen.getByLabelText('Remove line')).toBeEnabled();
    expect(screen.getByLabelText('Reservation status')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByLabelText('Procurement status')).not.toHaveAttribute('aria-disabled');

    await user.click(screen.getByLabelText('Receive into stock'));
    expect(h.receiveMutate).toHaveBeenCalledTimes(1);
  });

  it('locks receiving while a receipt is in flight, so a second click cannot fire', async () => {
    h.receive = { isPending: true, variables: { lineId: 'line-1' } };
    const user = userEvent.setup();
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);

    expect(screen.getByLabelText('Receive into stock')).toBeDisabled();
    await user.click(screen.getByLabelText('Receive into stock'));
    expect(h.receiveMutate).not.toHaveBeenCalled();

    // Each control is wired to its own mutation — a receipt must not lock the rest of the row.
    expect(screen.getByLabelText('Remove line')).toBeEnabled();
    expect(screen.getByLabelText('Reservation status')).not.toHaveAttribute('aria-disabled');
  });

  it('locks removal while a removal is in flight, so a second click cannot fire', async () => {
    h.remove = { isPending: true, variables: 'line-1' };
    const user = userEvent.setup();
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);

    expect(screen.getByLabelText('Remove line')).toBeDisabled();
    await user.click(screen.getByLabelText('Remove line'));
    expect(h.removeMutate).not.toHaveBeenCalled();

    expect(screen.getByLabelText('Receive into stock')).toBeEnabled();
  });

  it.each([
    ['Reservation status', () => (h.reservationPending = true)],
    ['Procurement status', () => (h.procurementPending = true)],
  ])('locks the %s control while its own status write is in flight', (label, setPending) => {
    setPending();
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-disabled', 'true');
  });

  it('locks every row but shows the wait only on the line being acted on', () => {
    h.remove = { isPending: true, variables: 'line-2' };
    render(<BomLineTable projectId="proj-1" lines={[inTransit('line-1'), inTransit('line-2')]} />);

    // The guard is table-wide (one mutation state), so both remove buttons lock…
    const [first, second] = screen.getAllByLabelText('Remove line');
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    // …but only line-2 swaps its icon for the spinner, so the table does not read as if the
    // whole bill of materials were being deleted.
    expect(first.querySelector('.animate-spin')).toBeNull();
    expect(second.querySelector('.animate-spin')).not.toBeNull();
  });
});

/**
 * A receive control for an item with no counted quantity (issue #608). The control used to offer
 * a batch number and an expiry the write discarded, under a tooltip promising "Receive N into
 * stock" for a receipt that added none.
 */
describe('BomLineTable — receiving an item that cannot hold counted stock', () => {
  const inTransit = () => makeLine({ procurementStatus: 'IN_TRANSIT', requiredQty: 5, itemId: 'ap' });

  it('renames the action and drops the batch and expiry fields', () => {
    h.trackingModeByItem = new Map<string, TrackingMode>([['ap', 'SERIALISED']]);
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);

    expect(screen.getByLabelText('Record as received (no stock added)')).toBeEnabled();
    expect(screen.queryByLabelText('Receive into stock')).toBeNull();
    expect(screen.queryByTestId('receive-batch-line-1')).toBeNull();
    expect(screen.queryByTestId('receive-expiry-line-1')).toBeNull();
    // The instalment quantity stays: a partial delivery is still a partial delivery.
    expect(screen.getByLabelText('Quantity to receive')).toBeInTheDocument();
  });

  it('receives as before for a bulk item, and while the batched read is still in flight', () => {
    h.trackingModeByItem = new Map<string, TrackingMode>([['ap', 'DISCRETE']]);
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);
    expect(screen.getByLabelText('Receive into stock')).toBeInTheDocument();
    expect(screen.getByTestId('receive-batch-line-1')).toBeInTheDocument();

    cleanup();
    // Undefined = the read has not landed. Warning on a value it does not have yet would show a
    // caution the next render takes back.
    h.trackingModeByItem = undefined;
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);
    expect(screen.getByLabelText('Receive into stock')).toBeInTheDocument();
  });

  it('still sends the instalment quantity, with no batch identity', async () => {
    h.trackingModeByItem = new Map<string, TrackingMode>([['ap', 'UNTRACKED']]);
    const user = userEvent.setup();
    render(<BomLineTable projectId="proj-1" lines={[inTransit()]} />);

    await user.click(screen.getByLabelText('Record as received (no stock added)'));
    expect(h.receiveMutate).toHaveBeenCalledWith({ lineId: 'line-1', quantity: 5, batch: undefined });
  });
});
