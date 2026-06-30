/**
 * Component tests for CycleCountDialog — focused on the WCAG 4.1.3 aria-live
 * announcement of the reconciliation result (Phase 63).
 *
 * Strategy: use a real QueryClient + QueryClientProvider (no @tanstack/react-query
 * mock — mocking that module crashes the vitest threads-pool worker) and stub the
 * repository so the query resolves to a known location with one discrete item.
 * The reconcile hooks are mocked at the `../hooks` boundary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CycleCountDialog } from './CycleCountDialog';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stub the item repository with one discrete batch so the form renders with
// an "Authorise" button that can be clicked.
const ONE_BATCH = {
  itemId: 'item-abc',
  name: 'Widget',
  batchKey: 'default',
  batchNumber: null,
  lotNumber: null,
  expiryDate: null,
  quantity: 10,
};
// The component builds the count-input testid from `${itemId}|${batchKey}`.
const BATCH_LINE_KEY = `${ONE_BATCH.itemId}|${ONE_BATCH.batchKey}`;

vi.mock('@/db/repositories', () => ({
  getItemRepository: () => ({
    listStockBatchesAtLocation: () => Promise.resolve([ONE_BATCH]),
    list: () => Promise.resolve({ rows: [] }),
  }),
}));

// Reconcile hooks — spies resolved with [] by default; individual tests override.
const reconcileSpy = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const reconcileSerialisedSpy = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('../hooks', () => ({
  useReconcile: () => ({ mutateAsync: reconcileSpy, isPending: false }),
  useReconcileSerialised: () => ({ mutateAsync: reconcileSerialisedSpy, isPending: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const LOC = { id: 'loc-1', name: 'Drawer A2' };

function renderDialog(client = makeClient()) {
  return render(
    <QueryClientProvider client={client}>
      <CycleCountDialog open location={LOC} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  reconcileSpy.mockResolvedValue([]);
  reconcileSerialisedSpy.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CycleCountDialog — aria-live reconciliation result (WCAG 4.1.3, Phase 63)', () => {
  it('mounts a role="status" live region BEFORE reconciliation completes', async () => {
    renderDialog();
    // The LiveRegion (role=status, polite) must be in the DOM while the form is
    // displayed — not only after the result appears (WCAG 4.1.3 requires pre-existence).
    const region = screen.getByRole('status');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('');
  });

  it('the live region carries role="status" and aria-live="polite"', () => {
    renderDialog();
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
  });

  it('populates the live region with the completion message after authorise', async () => {
    // Spy resolves with 2 items so the message reads "2 adjustments".
    const fakeItem = { id: 'item-abc' };
    reconcileSpy.mockResolvedValue([fakeItem, fakeItem]);

    renderDialog();

    // Wait for the query to resolve and the count input to appear.
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    // Enter a count that differs from the expected quantity (10 → 8: variance -2)
    // so that totalToApply > 0 and the Authorise button becomes enabled.
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), {
      target: { value: '8' },
    });

    // Click Authorise and let the async reconciliation complete.
    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    const region = screen.getByRole('status');
    expect(region.textContent).toContain('Reconciliation complete');
    expect(region.textContent).toContain('2 adjustments applied to the ledger');
  });

  it('uses singular "adjustment" when exactly 1 item was reconciled', async () => {
    reconcileSpy.mockResolvedValue([{ id: 'item-abc' }]);

    renderDialog();

    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), {
      target: { value: '8' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    const region = screen.getByRole('status');
    expect(region.textContent).toContain('1 adjustment applied');
    expect(region.textContent).not.toContain('1 adjustments');
  });

  it('keeps the same live-region DOM node before and after reconciliation (no remount trap)', async () => {
    reconcileSpy.mockResolvedValue([{ id: 'item-abc' }]);

    renderDialog();

    // Capture the live-region element reference while the form is active.
    const regionBefore = screen.getByRole('status');

    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), {
      target: { value: '8' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    // The SAME DOM element must still be the role=status node after reconciliation —
    // a remount would yield a different reference and prove the trap is present.
    const regionAfter = screen.getByRole('status');
    expect(regionBefore).toBe(regionAfter);
  });
});
