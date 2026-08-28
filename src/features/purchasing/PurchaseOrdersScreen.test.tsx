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
let deletePoSpy: ReturnType<typeof vi.fn>;
let removeLineSpy: ReturnType<typeof vi.fn>;
const refetchOrders = vi.fn();

/** Controls usePurchaseOrderCount — the total across every page (issue #149). */
let orderCountState: number | undefined;

/** Controls usePurchaseOrders for the master-list result-count tests (Phase 64). */
let ordersState: {
  isLoading: boolean;
  isError?: boolean;
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

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care that the screen offers it.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

vi.mock('./queries', () => ({
  // The export's read-everything walk (issue #132); never invoked here, as the menu is stubbed.
  readPurchaseOrdersPage: vi.fn(),
  /**
   * The order list pages **server-side** (issue #149), so the stub serves pages the way the
   * repository does: `ordersState.data.rows` is every order, and the hook returns only the
   * requested window of it, capped at the repository's ceiling.
   */
  usePurchaseOrders: (page = 1, pageSize = 100) => {
    if (!ordersState.data) return { ...ordersState, refetch: refetchOrders };
    const all = ordersState.data.rows;
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;
    const rows = all.slice(offset, offset + limit);
    return {
      ...ordersState,
      data: { rows, offset, limit, hasMore: offset + rows.length < all.length },
      refetch: refetchOrders,
    };
  },
  // The total across every page. Defaults to the whole fixture, as the real COUNT(*) would.
  usePurchaseOrderCount: () => ({ data: orderCountState ?? ordersState.data?.rows.length }),
  usePurchaseOrder: () => ({
    isLoading: false,
    data: poData,
  }),
  useCreatePurchaseOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPurchaseOrderStatus: () => ({ mutate: setStatusSpy, isPending: false }),
  useDeletePurchaseOrder: () => ({ mutate: deletePoSpy, isPending: false }),
  useAddPurchaseOrderLine: () => ({ mutate: vi.fn(), isPending: false }),
  useRemovePurchaseOrderLine: () => ({ mutate: removeLineSpy, isPending: false }),
  useReceivePurchaseOrderLine: () => ({ mutate: receiveLineSpy, isPending: false }),
  useReturnPurchaseOrderLine: () => ({ mutate: vi.fn(), isPending: false }),
  // Phase 65 — Reorder / Shopping-list tab
  useReorderPlan: () => ({ isLoading: false, data: [] }),
  useCreateDraftFromReorderPlan: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));

// Feature-gap G8 — Wishlist tab. Its panel is always mounted (hidden), so its query hooks run
// on render; stub them so the screen needs no real repository/driver.
vi.mock('./wishlist-queries', () => ({
  useWishlist: () => ({ isLoading: false, data: { rows: [] } }),
  useCreateWishlistEntry: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
  useUpdateWishlistEntry: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteWishlistEntry: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}));

vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: () => ({ data: { pages: [] } }),
  useLocations: () => ({ data: { rows: [] } }),
  // Issue #608 — the receiving line's item, read for its tracking mode so the receive dialog
  // knows whether the receipt can land stock. Unresolved by default, as it is before the read
  // lands; a test that cares seeds it.
  useItem: () => ({ data: undefined }),
  // The names of the items this order's lines link to (issue #484), and the line editor's own
  // reads of the item it is pricing.
  useItemsById: () => ({ data: new Map() }),
  useItemRelevanceSearch: () => ({ data: undefined }),
  useItemSupplierParts: () => ({ data: [] }),
}));

/** Currency-code → symbol for the formatter stub; anything unmapped renders as the base £. */
const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$' };

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    // Honours the optional currency override so a test can tell a EUR order's total from a
    // base-currency one (issue #285); omitted ⇒ the base currency, as in the real formatter.
    currency: (v: number, code?: string) => `${SYMBOLS[code ?? ''] ?? '£'}${v.toFixed(2)}`,
    // Mirrors `currency` split into Intl-style parts so the <Money> control renders.
    currencyParts: (v: number, code?: string) => [
      { type: 'currency', value: SYMBOLS[code ?? ''] ?? '£' },
      { type: 'literal', value: v.toFixed(2) },
    ],
    // The scale an order's estimated value is quantised to (issue #292) — sterling's two.
    currencyFractionDigits: () => 2,
    quantity: (v: number) => String(v),
    date: () => '',
    dateTime: () => '',
    relativeTime: () => '',
    percent: () => '',
  }),
}));

// Stub the router Link so the screen renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// The global nav menu has its own suite; stub it so this screen test needs no
// router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
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
vi.mock('./components/ImportPurchaseListDialog', () => ({
  ImportPurchaseListDialog: () => null,
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

import { PurchaseOrdersScreen } from './PurchaseOrdersScreen';
import { ToastProvider } from '@/components/foundry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * The screen under a ToastProvider — deleting an order or removing a line reports its outcome
 * through a toast, so the provider is part of the screen's real wiring rather than test scaffolding.
 * `rerender` keeps the wrapper, so the receipt-progress test still works through it.
 */
function renderScreen() {
  return render(<PurchaseOrdersScreen />, { wrapper: ToastProvider });
}

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
  orderCountState = undefined;

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

  refetchOrders.mockClear();

  // setStatus spy: synchronously calls onSuccess when invoked.
  setStatusSpy = vi.fn((_vars: unknown, callbacks?: { onSuccess?: () => void }) => {
    callbacks?.onSuccess?.();
  });

  // receiveLine spy: synchronously calls onSuccess when invoked.
  receiveLineSpy = vi.fn((_vars: unknown, callbacks?: { onSuccess?: () => void }) => {
    callbacks?.onSuccess?.();
  });

  // The two destructive writes (issue #588), each calling back synchronously on success.
  deletePoSpy = vi.fn((_id: unknown, callbacks?: { onSuccess?: () => void }) => {
    callbacks?.onSuccess?.();
  });
  removeLineSpy = vi.fn((_vars: unknown, callbacks?: { onSuccess?: () => void }) => {
    callbacks?.onSuccess?.();
  });
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('PurchaseOrdersScreen — aria-live status messages (WCAG 4.1.3)', () => {
  it('mounts the status live region before any action is taken', () => {
    renderScreen();
    // role="status" is the polite live region rendered by <LiveRegion>.
    // There will be two in the detail panel; at least one should be empty on mount.
    const regions = screen.getAllByRole('status');
    expect(regions.length).toBeGreaterThanOrEqual(2);
    // On first render neither region has content (no action has been taken yet).
    const statusRegion = screen.getByTestId('po-status-live');
    expect(statusRegion.textContent).toBe('');
  });

  it('announces "Ordered" after Mark as ordered succeeds', () => {
    renderScreen();

    const markOrderedBtn = screen.getByTestId('po-mark-ordered');
    fireEvent.click(markOrderedBtn);

    expect(setStatusSpy).toHaveBeenCalledOnce();
    // The spy calls onSuccess synchronously, which calls setStatusAnnouncement.
    const statusRegion = screen.getByTestId('po-status-live');
    expect(statusRegion.textContent).toContain('Ordered');
  });

  it('announces "Cancelled" after Cancel order succeeds', () => {
    renderScreen();

    const cancelBtn = screen.getByTestId('po-cancel');
    fireEvent.click(cancelBtn);

    expect(setStatusSpy).toHaveBeenCalledOnce();
    const statusRegion = screen.getByTestId('po-status-live');
    expect(statusRegion.textContent).toContain('Cancelled');
  });

  it('mounts the receipt live region before any receipt action', () => {
    renderScreen();
    const receiptRegion = screen.getByTestId('po-receipt-live');
    expect(receiptRegion.textContent).toBe('');
  });

  it('announces the updated receipt progress when currentReceived increases', async () => {
    const { rerender } = renderScreen();

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
    renderScreen();
    const region = screen.getByTestId('po-list-count-live');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('the master-list count region is visually hidden (sr-only)', () => {
    renderScreen();
    const region = screen.getByTestId('po-list-count-live');
    expect(region.className).toContain('sr-only');
  });

  it('announces "Loading" while the orders query is in-flight', () => {
    ordersState = { isLoading: true };
    renderScreen();
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent?.toLowerCase()).toContain('loading');
  });

  it('announces the order count once orders resolve', () => {
    // ordersState is reset in beforeEach to one order.
    renderScreen();
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent).toContain('1');
    expect(region.textContent?.toLowerCase()).toContain('purchase order');
  });

  it('uses singular form for exactly one order', () => {
    renderScreen();
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent).toContain('1 purchase order');
    expect(region.textContent).not.toContain('1 purchase orders');
  });

  it('announces the empty state when there are no orders', () => {
    ordersState = { isLoading: false, data: { rows: [] } };
    renderScreen();
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
    renderScreen();
    const region = screen.getByTestId('po-list-count-live');
    expect(region.textContent).toContain('3');
    expect(region.textContent?.toLowerCase()).toContain('purchase orders');
  });
});

describe("PurchaseOrdersScreen — an order's total renders in the order's currency (issue #285)", () => {
  /** One list row whose lines total 100, in the given currency. */
  function orderIn(currency: string | null): PurchaseOrderWithLines {
    return {
      id: 'po-1',
      supplierName: 'Acme',
      reference: 'REF-001',
      effectiveStatus: 'ORDERED',
      currency,
      lines: [
        {
          id: 'l-1',
          poId: 'po-1',
          itemId: null,
          description: 'Part',
          orderedQty: 2,
          receivedQty: 0,
          unitCost: 50,
        },
      ],
    } as unknown as PurchaseOrderWithLines;
  }

  it("renders a EUR order's total under the euro sign, not the base currency's", () => {
    // The line costs were copied verbatim from a EUR supplier quote and are never converted,
    // so showing €100 as "£100.00" would misstate the order by the exchange rate.
    ordersState = { isLoading: false, data: { rows: [orderIn('EUR')] } };
    renderScreen();
    const row = screen.getAllByTestId('po-list-row')[0]!;
    expect(row.textContent).toContain('€100.00');
    expect(row.textContent).not.toContain('£');
  });

  it('falls back to the base currency when the order carries no code', () => {
    ordersState = { isLoading: false, data: { rows: [orderIn(null)] } };
    renderScreen();
    const row = screen.getAllByTestId('po-list-row')[0]!;
    expect(row.textContent).toContain('£100.00');
  });

  it("renders a EUR order's per-line price under the euro sign in the detail panel", () => {
    // The line dialog already showed € for these same numbers; the detail list must agree.
    poData = { ...makeDraftPo(), currency: 'EUR' } as unknown as PurchaseOrderWithLines;
    poData = {
      ...poData,
      lines: [{ ...poData.lines[0]!, unitCost: 50 }],
    } as unknown as PurchaseOrderWithLines;
    renderScreen();
    const line = screen.getAllByTestId('po-line-row')[0]!;
    expect(line.textContent).toContain('€50.00');
    expect(line.textContent).not.toContain('£');
  });
});

describe('PurchaseOrdersScreen — failed order-list load (issue #306)', () => {
  it('reports the error instead of the "no purchase orders yet" empty state', () => {
    ordersState = { isLoading: false, isError: true };
    renderScreen();
    expect(screen.getByTestId('po-error').textContent).toContain('couldn’t be loaded');
    expect(screen.queryByTestId('po-empty')).toBeNull();
  });

  it('offers a retry that refetches', () => {
    ordersState = { isLoading: false, isError: true };
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchOrders).toHaveBeenCalled();
  });

  it('the count live region stays silent on failure (the alert speaks instead)', () => {
    ordersState = { isLoading: false, isError: true };
    renderScreen();
    expect(screen.getByTestId('po-list-count-live').textContent).toBe('');
  });
});

describe('PurchaseOrdersScreen — a list longer than one read (issue #149)', () => {
  afterEach(() => {
    usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
  });

  /** 125 orders — more than the repository will return in a single capped read. */
  const manyOrders = {
    isLoading: false,
    data: {
      rows: Array.from(
        { length: 125 },
        (_, i) =>
          ({
            id: `po-${i}`,
            supplierName: `Supplier ${String(i + 1).padStart(3, '0')}`,
            reference: `REF-${i}`,
            effectiveStatus: 'DRAFT',
            lines: [],
          }) satisfies PurchaseOrderWithLines,
      ),
    },
  };

  it('says how many orders the capped read leaves out when pagination is off', () => {
    ordersState = manyOrders;
    renderScreen();

    const notice = screen.getByTestId('po-truncated');
    expect(notice.textContent).toContain('100');
    expect(notice.textContent).toContain('25');
    expect(screen.queryByText('Supplier 101')).toBeNull();
  });

  it('reports the whole set in the live region, not just the page in view', () => {
    ordersState = manyOrders;
    renderScreen();
    expect(screen.getByTestId('po-list-count-live').textContent).toContain('125 purchase orders');
  });

  it('reaches the orders past the first read once pagination is on', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 100 });
    ordersState = manyOrders;
    renderScreen();

    expect(screen.queryByTestId('po-truncated')).toBeNull();
    expect(screen.getByTestId('po-pagination-summary')).toHaveTextContent('1–100 of 125');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('po-pagination-summary')).toHaveTextContent('101–125 of 125');
    expect(screen.getByText('Supplier 101')).toBeInTheDocument();
  });

  it('shows no truncation notice when every order fits in one read', () => {
    renderScreen();
    expect(screen.queryByTestId('po-truncated')).toBeNull();
  });
});

/**
 * The order book can be taken away as a file (issue #132). The menu is stubbed (its download +
 * toast machinery has its own suite), so these assert what this screen owns: that the Orders tab
 * offers the control, and gates it on there being an order to write.
 */
describe('PurchaseOrdersScreen — export', () => {
  it('offers an export on the Orders tab', () => {
    renderScreen();
    expect(screen.getByTestId('export-purchase-orders')).not.toBeDisabled();
  });

  it('disables it while there are no orders to write', () => {
    ordersState = { isLoading: false, data: { rows: [] } };
    orderCountState = 0;
    renderScreen();
    expect(screen.getByTestId('export-purchase-orders')).toBeDisabled();
  });

  it('is offered only on the Orders tab, not the Reorder or Wishlist ones', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-tab-wishlist'));
    expect(screen.queryByTestId('export-purchase-orders')).toBeNull();
  });
});

/**
 * Deleting an order — or one of its lines — is a hard delete that reaches every synced device
 * and has no restore path, so each asks first (issue #588). These assert the gate itself: the
 * write does not happen on the click that opens the dialog, the copy names what is lost, and
 * dismissing leaves the record alone.
 */
describe('PurchaseOrdersScreen — deleting an order asks first (issue #588)', () => {
  it('does not delete on the click that opens the confirmation', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-delete'));
    expect(deletePoSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('names the order and how many lines go with it', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-delete'));
    // The fixture order carries one line, so the singular variant is chosen.
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('REF-001');
    expect(dialog.textContent).toContain('1 line');
    expect(dialog.textContent).not.toContain('1 lines');
  });

  it('says what happens to stock already received against the order', () => {
    poData = makeDraftPo({
      lines: [
        {
          id: 'line-1',
          poId: 'po-1',
          itemId: null,
          description: 'Resistor 10k',
          orderedQty: 10,
          receivedQty: 4,
          unitCost: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    renderScreen();
    fireEvent.click(screen.getByTestId('po-delete'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Already received: 4 of 10');
    expect(dialog.textContent).toContain('stays in your inventory');
  });

  it('leaves the received note out when nothing has been received', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-delete'));
    expect(screen.getByRole('dialog').textContent).not.toContain('Already received');
  });

  it('deletes once confirmed', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-delete'));
    fireEvent.click(screen.getByTestId('po-delete-confirm'));
    expect(deletePoSpy).toHaveBeenCalledWith('po-1', expect.anything());
  });

  it('leaves the order alone when the confirmation is dismissed', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deletePoSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('carries a readable label rather than a bare bin', () => {
    renderScreen();
    expect(screen.getByTestId('po-delete').textContent).toContain('Delete order');
  });

  it('reserves the destructive styling for the delete, not the reversible Cancel order', () => {
    renderScreen();
    // `variant="destructive"` is the solid `bg-destructive` fill; cancelling is undone by
    // "Reopen as draft", so wearing it made the two adjacent buttons read as equally final.
    // Split on whitespace rather than substring-matching: `hover:text-destructive` contains
    // `text-destructive`, so a substring check would pass even with the base token gone.
    const classesOf = (testId: string) => screen.getByTestId(testId).className.split(/\s+/);
    expect(classesOf('po-cancel')).not.toContain('bg-destructive');
    expect(classesOf('po-delete')).toContain('text-destructive');
  });
});

describe('PurchaseOrdersScreen — removing a line asks first (issue #588)', () => {
  it('does not remove on the click that opens the confirmation', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-remove-line'));
    expect(removeLineSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('Resistor 10k');
  });

  it('removes once confirmed', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-remove-line'));
    fireEvent.click(screen.getByTestId('po-remove-line-confirm'));
    expect(removeLineSpy).toHaveBeenCalledWith({ poId: 'po-1', lineId: 'line-1' }, expect.anything());
  });

  it('leaves the line alone when the confirmation is dismissed', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('po-remove-line'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeLineSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the line in the remove button, so several rows are told apart', () => {
    renderScreen();
    expect(screen.getByRole('button', { name: 'Remove Resistor 10k from this order' })).toBeInTheDocument();
  });
});
