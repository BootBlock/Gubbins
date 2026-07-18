import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
}));

vi.mock('../projects', () => ({
  useRemoveBomLine: () => ({ mutate: vi.fn() }),
  useSetProcurement: () => ({ mutate: vi.fn() }),
  useSetReservation: () => ({ mutate: vi.fn() }),
  useReceiveLine: () => ({ mutate: vi.fn() }),
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
