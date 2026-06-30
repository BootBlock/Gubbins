/**
 * Component tests for PurchaseOrdersScreen — WCAG 4.1.3 aria-live coverage.
 *
 * Phase 63: status live region (detail panel) — status-badge transitions and
 * receipt-progress announcements.
 *
 * Phase 64 (aria-live Tier B): master-list result-count live region — asserts
 * the always-mounted polite region announces the order count / empty state.
 *
 * Mocked at the queries boundary so no DB or QueryClient is needed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { PurchaseOrderWithLines } from '@/db/repositories';

// ─── query spies ─────────────────────────────────────────────────────────────

/**
 * Shared mutable state for query hooks so individual tests can update them and
 * trigger re-renders (simulating a mutation → cache invalidation → refetch).
 */
let poData: PurchaseOrderWithLines | undefined;
let setStatusSpy: ReturnType<typeof vi.fn>;
let receiveLineSpy: ReturnType<typeof vi.fn>;

/** Controls usePurchaseOrders for the master-list result-count tests (Phase 64). */
let ordersState: {
  isLoading: boolean;
  data?: { rows: PurchaseOrderWithLines[] };
} = {
  isLoading: false,
  data: {
    rows: [
      {
        id: 'po-1',
        supplierName: 'Acme Supplies',
        reference: 'REF-001',
        effectiveStatus: 'DRAFT',
        lines: [],
      } satisfies PurchaseOrderWithLines,
    ],
  },
};

vi.mock('./queries', () => ({
  usePurchaseOrders: () => ordersState,
  usePurchaseOrder: () => ({
    isLoading: false,
    data: poData,
  }),
  useCreatePurchaseOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPurchaseOrderStatus: () => ({ mutate: setStatusSpy, isPending: false }),
  useDeletePurchaseOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useAddPurchaseOrderLine: () => ({ mutate: vi.fn(), isPending: false }),
  useRemovePurchaseOrderLine: () => ({ mutate: vi.fn(), isPending: false }),
  useReceivePurchaseOrderLine: () => ({ mutate: receiveLineSpy, isPending: false }),
  // Phase 65 — Reorder / Shopping-list tab
  useReorderPlan: () => ({ isLoading: false, data: [] }),
  useCreateDraftFromReorderPlan: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false }),
}));

vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: () => ({ data: { pages: [] } }),
  useLocations: () => ({ data: { rows: [] } }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    quantity: (v: number) => String(v),
    date: () => '',
    dateTime: () => '',
    relativeTime: () => '',
    percent: () => '',
  }),
}));

// Stub the router Link so the screen renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// The global nav menu has its own suite; stub it so this screen test needs no
// router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <nav data-testid="app-nav" aria-label="Navigation" />,
}));

// Stub dialogs — they are outside scope and add noise; we only care about the
// live regions in the detail panel.
vi.mock('./components/CreatePurchaseOrderDialog', () => ({
  CreatePurchaseOrderDialog: () => null,
}));
vi.mock('./components/PurchaseOrderLineDialog', () => ({
  PurchaseOrderLineDialog: () => null,
}));
vi.mock('./components/ReceiveLineDialog', () => ({
  ReceiveLineDialog: () => null,
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

import { PurchaseOrdersScreen } from './PurchaseOrdersScreen';

/** A minimal Draft PO with one line (10 ordered, 0 received). */
function makeDraftPo(overrides: Partial<PurchaseOrderWithLines> = {}): PurchaseOrderWithLines {
  return {
    id: 'po-1',
    supplierName: 'Acme Supplies',
    reference: 'REF-001',
    effectiveStatus: 'DRAFT',
    lines: [
      {
        id: 'line-1',
        poId: 'po-1',
        itemId: null,
        description: 'Resistor 10k',
        orderedQty: 10,
        receivedQty: 0,
        unitCost: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    ...overrides,
  };
}

afterEach(cleanup);

beforeEach(() => {
  poData = makeDraftPo();

  // Reset the orders-list state to the default single-PO fixture (preserves
  // existing Phase-63 tests which assume one order is present).
  ordersState = {
    isLoading: false,
    data: {
      rows: [
        {
          id: 'po-1',
          supplierName: 'Acme Supplies',
          reference: 'REF-001',
          effectiveStatus: 'DRAFT',
          lines: [],
        } satisfies PurchaseOrderWithLines,
      ],
    },
  };

  // setStatus spy: synchronously calls onSuccess when invoked.
  setStatusSpy = vi.fn(
    (_vars: unknown, callbacks?: { onSuccess?: () => void }) => {
      callbacks?.onSuccess?.();
    },
  );

  // receiveLine spy: synchronously calls onSuccess when invoked.
  receiveLineSpy = vi.fn(
    (_vars: unknown, callbacks?: { onSuccess?: () => void }) => {
      callbacks?.onSuccess?.();
    },
  );
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('PurchaseOrdersScreen — aria-live status messages (WCAG 4.1.3)', () => {
  it('mounts the status live region before any action is taken', () => {
    render(<PurchaseOrdersScreen />);
    // role="status" is the polite live region rendered by <LiveRegion>.
    // There will be two in the detail panel; at least one should be empty on mount.
    const regions = screen.getAllByRole('status');
    expect(regions.length).toBeGreaterThanOrEqual(2);
    // On first render neither region has content (no action has been taken yet).
    const statusRegion = screen.getByTestId('po-status-live');
    expect(statusRegion.textContent).toBe('');
  });

  it('announces "Ordered" after Mark as ordered succeeds', () => {
    render(<PurchaseOrdersScreen />);

    const markOrderedBtn = screen.getByTestId('po-mark-ordered');
    fireEvent.click(markOrderedBtn);

    expect(setStatusSpy).toHaveBeenCalledOnce();
    // The spy calls onSuccess synchronously, which calls setStatusAnnouncement.
    const statusRegion = screen.getByTestId('po-status-live');
    expect(statusRegion.textContent).toContain('Ordered');
  });

  it('announces "Cancelled" after Cancel order succeeds', () => {
    render(<PurchaseOrdersScreen />);

    const cancelBtn = screen.getByTestId('po-cancel');
    fireEvent.click(cancelBtn);

    expect(setStatusSpy).toHaveBeenCalledOnce();
    const statusRegion = screen.getByTestId('po-status-live');
    expect(statusRegion.textContent).toContain('Cancelled');
  });

  it('mounts the receipt live region before any receipt action', () => {
    render(<PurchaseOrdersScreen />);
    const receiptRegion = screen.getByTestId('po-receipt-live');
    expect(receiptRegion.textContent).toBe('');
  });

  it('announces the updated receipt progress when currentReceived increases', async () => {
    const { rerender } = render(<PurchaseOrdersScreen />);

    // Simulate a receipt: the PO refetches with receivedQty updated.
    act(() => {
      poData = makeDraftPo({
        lines: [
          {
            id: 'line-1',
            poId: 'po-1',
            itemId: null,
            description: 'Resistor 10k',
            orderedQty: 10,
            receivedQty: 5,
            unitCost: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });
    });

    // Re-render with updated poData (mock returns the latest `poData` reference).
    rerender(<PurchaseOrdersScreen />);

    const receiptRegion = screen.getByTestId('po-receipt-live');
    expect(receiptRegion.textContent).toContain('5');
    expect(receiptRegion.textContent).toContain('10');
    expect(receiptRegion.textContent?.toLowerCase()).toContain('receipt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 64 — Tier B: master-list result-count live region
// ─────────────────────────────────────────────────────────────────────────────

describe('PurchaseOrdersScreen — master-list result-count aria-live (WCAG 4.1.3, Phase 64)', () => {
  it('mounts the master-list count live region before data resolves', () => {
    ordersState = { isLoading: true };
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('the master-list count region is visually hidden (sr-only)', () => {
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region.className).toContain('sr-only');
  });

  it('announces "Loading" while the orders query is in-flight', () => {
    ordersState = { isLoading: true };
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent?.toLowerCase()).toContain('loading');
  });

  it('announces the order count once orders resolve', () => {
    // ordersState is reset in beforeEach to one order.
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent).toContain('1');
    expect(region.textContent?.toLowerCase()).toContain('purchase order');
  });

  it('uses singular form for exactly one order', () => {
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent).toContain('1 purchase order');
    expect(region.textContent).not.toContain('1 purchase orders');
  });

  it('announces the empty state when there are no orders', () => {
    ordersState = { isLoading: false, data: { rows: [] } };
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent?.toLowerCase()).toContain('no purchase orders');
  });

  it('announces the count for multiple orders', () => {
    ordersState = {
      isLoading: false,
      data: {
        rows: [
          { id: 'po-1', supplierName: 'Acme', reference: null, effectiveStatus: 'DRAFT', lines: [] },
          { id: 'po-2', supplierName: 'BetaCo', reference: null, effectiveStatus: 'ORDERED', lines: [] },
          { id: 'po-3', supplierName: 'GammaCorp', reference: null, effectiveStatus: 'RECEIVED', lines: [] },
        ] as PurchaseOrderWithLines[],
      },
    };
    render(<PurchaseOrdersScreen />);
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent).toContain('3');
    expect(region.textContent?.toLowerCase()).toContain('purchase orders');
  });
});
