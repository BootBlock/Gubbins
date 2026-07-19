import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProjectBomLine } from '@/db/repositories';

/**
 * Behaviour tests for the {@link BomLineTable} hard-dependency flag (issue #70). A BOM line whose
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
}));

vi.mock('../projects', () => ({
  useRemoveBomLine: () => ({ mutate: h.removeMutate, ...h.remove }),
  useSetProcurement: () => ({ mutate: vi.fn(), isPending: h.procurementPending }),
  useSetReservation: () => ({ mutate: vi.fn(), isPending: h.reservationPending }),
  useReceiveLine: () => ({ mutate: h.receiveMutate, ...h.receive }),
}));
vi.mock('@/features/inventory/queries', () => ({
  useItemsRelations: () => ({ data: h.relationsByItem }),
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

beforeEach(() => {
  h.relationsByItem = new Map();
  h.receive = { isPending: false, variables: undefined };
  h.remove = { isPending: false, variables: undefined };
  h.reservationPending = false;
  h.procurementPending = false;
  h.receiveMutate.mockClear();
  h.removeMutate.mockClear();
});
afterEach(cleanup);

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
