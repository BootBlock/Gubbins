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
import { CycleCountProvider } from '../CycleCountContext';
import { useCountDraftStore } from '../useCountDraftStore';
import { useLocationCycleCount, type LocationCycleCount } from '../useLocationCycleCount';

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
const authoriseCountSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ discrete: [], serialised: [] }));

vi.mock('../hooks', () => ({
  useAuthoriseCount: () => ({ mutateAsync: authoriseCountSpy, isPending: false }),
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
  authoriseCountSpy.mockResolvedValue({ discrete: [], serialised: [] });
  // The count sheet is now saved to `localStorage` as it is typed (issue #587), so a count
  // entered by one test would be restored into the next one's dialog.
  useCountDraftStore.setState({ drafts: {} });
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CycleCountDialog — aria-live reconciliation result (WCAG 4.1.3, Phase 63)', () => {
  it('mounts a role="status" live region BEFORE reconciliation completes', async () => {
    renderDialog();
    // The LiveRegion (role=status, polite) must be in the DOM while the form is
    // displayed — not only after the result appears (WCAG 4.1.3 requires pre-existence).
    const region = screen.getByTestId('cycle-count-result');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');
  });

  it('the live region carries role="status" and aria-live="polite"', () => {
    renderDialog();
    const region = screen.getByTestId('cycle-count-result');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
  });

  it('populates the live region with the completion message after authorise', async () => {
    // Spy resolves with 2 items so the message reads "2 adjustments".
    const fakeItem = { id: 'item-abc' };
    authoriseCountSpy.mockResolvedValue({ discrete: [fakeItem, fakeItem], serialised: [] });

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

    const region = screen.getByTestId('cycle-count-result');
    expect(region.textContent).toContain('Reconciliation complete');
    expect(region.textContent).toContain('2 adjustments applied to the ledger');
  });

  it('uses singular "adjustment" when exactly 1 item was reconciled', async () => {
    authoriseCountSpy.mockResolvedValue({ discrete: [{ id: 'item-abc' }], serialised: [] });

    renderDialog();

    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), {
      target: { value: '8' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    const region = screen.getByTestId('cycle-count-result');
    expect(region.textContent).toContain('1 adjustment applied');
    expect(region.textContent).not.toContain('1 adjustments');
  });

  it('keeps the same live-region DOM node before and after reconciliation (no remount trap)', async () => {
    authoriseCountSpy.mockResolvedValue({ discrete: [{ id: 'item-abc' }], serialised: [] });

    renderDialog();

    // Capture the live-region element reference while the form is active.
    const regionBefore = screen.getByTestId('cycle-count-result');

    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), {
      target: { value: '8' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    // The SAME DOM element must still be the role=status node after reconciliation —
    // a remount would yield a different reference and prove the trap is present.
    const regionAfter = screen.getByTestId('cycle-count-result');
    expect(regionBefore).toBe(regionAfter);
  });
});

describe('CycleCountDialog — the count sheet survives being closed (issue #587)', () => {
  /** Open the dialog, wait for the sheet, and type `value` into the one discrete line. */
  async function countInto(value: string) {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), { target: { value } });
  }

  it('keeps what was typed when the dialog is closed, and hands it back on reopening', async () => {
    await countInto('8');
    // Closing (Cancel, Escape or a backdrop tap) unmounts the provider — the count used to die
    // with it, recoverable only by physically counting the shelf again.
    cleanup();

    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    expect(screen.getByTestId<HTMLInputElement>(`count-${BATCH_LINE_KEY}`).value).toBe('8');
  });

  it('says so rather than repopulating the sheet silently', async () => {
    await countInto('8');
    cleanup();

    renderDialog();
    await waitFor(() => expect(screen.getByTestId('count-draft-notice')).toBeTruthy());
    // A sheet saved seconds ago is said as "just now" — the relative formatter's bare "now"
    // reads as a broken sentence in this position.
    expect(screen.getByTestId('count-draft-notice').textContent).toContain(
      'Restored 1 count entered here just now.',
    );
    // …and announces it, from a region that pre-existed the message (WCAG 4.1.3).
    expect(screen.getByTestId('count-draft-live').textContent).toContain('Restored 1 count');
  });

  it('reports an older sheet by age rather than as "just now"', async () => {
    useCountDraftStore.setState({
      drafts: {
        [LOC.id]: { counts: { [BATCH_LINE_KEY]: '8' }, missing: [], savedAt: Date.now() - 3 * 86_400_000 },
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('count-draft-notice')).toBeTruthy());
    expect(screen.getByTestId('count-draft-notice').textContent).toContain('entered here 3 days ago');
  });

  it('says "earlier" rather than inventing a date when the stored stamp was unusable', async () => {
    useCountDraftStore.setState({
      drafts: { [LOC.id]: { counts: { [BATCH_LINE_KEY]: '8' }, missing: [], savedAt: null } },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('count-draft-notice')).toBeTruthy());
    expect(screen.getByTestId('count-draft-notice').textContent).toContain('entered here earlier');
  });

  it('says nothing on a location with no saved sheet', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    expect(screen.queryByTestId('count-draft-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('count-draft-live').textContent).toBe('');
  });

  it('"Start over" clears the restored sheet and the saved copy behind it', async () => {
    await countInto('8');
    cleanup();

    renderDialog();
    await waitFor(() => expect(screen.getByTestId('count-draft-discard')).toBeTruthy());
    fireEvent.click(screen.getByTestId('count-draft-discard'));

    expect(screen.getByTestId<HTMLInputElement>(`count-${BATCH_LINE_KEY}`).value).toBe('');
    expect(screen.queryByTestId('count-draft-notice')).not.toBeInTheDocument();
    await waitFor(() => expect(useCountDraftStore.getState().drafts[LOC.id]).toBeUndefined());
  });

  it('drops the saved sheet once the count is authorised, so it is never offered back', async () => {
    authoriseCountSpy.mockResolvedValue({ discrete: [{ id: 'item-abc' }], serialised: [] });
    await countInto('8');
    expect(useCountDraftStore.getState().drafts[LOC.id]).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });
    expect(useCountDraftStore.getState().drafts[LOC.id]).toBeUndefined();
  });

  it('empties the live sheet on authorise, so the post-write refetch cannot resurrect it', async () => {
    // Authorising invalidates this location's cycle-count query (its key sits under the items
    // prefix), so the provider is re-seeded while still mounted and its mirror effect runs
    // again. Clearing only the *stored* sheet would leave the live inputs holding the committed
    // numbers, and that re-seed would write them straight back as a draft of work that is now
    // the database's own state — offered back the next time this location is opened.
    let count: LocationCycleCount | null = null;
    function Harness() {
      count = useLocationCycleCount(LOC);
      return null;
    }
    render(
      <QueryClientProvider client={makeClient()}>
        <CycleCountProvider>
          <Harness />
        </CycleCountProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(count!.lines).toHaveLength(1));
    act(() => count!.setCount(BATCH_LINE_KEY, '8'));
    await waitFor(() => expect(useCountDraftStore.getState().drafts[LOC.id]).toBeDefined());

    await act(async () => {
      await count!.authorise();
    });

    expect(count!.counts).toEqual({});
    expect(useCountDraftStore.getState().drafts[LOC.id]).toBeUndefined();
  });

  it('keeps the sheet when authorisation fails — a failed write must not cost the count', async () => {
    // Driven through the hook rather than the button: the dialog fires `void authorise()`, so a
    // rejection there escapes as an unhandled one (the mutation reports the failure to the user
    // itself) and vitest would flag it. What matters is the ordering — the saved sheet is
    // dropped *after* the write lands, never before it is attempted.
    authoriseCountSpy.mockRejectedValue(new Error('disk full'));

    let count: LocationCycleCount | null = null;
    function Harness() {
      count = useLocationCycleCount(LOC);
      return null;
    }
    render(
      <QueryClientProvider client={makeClient()}>
        <CycleCountProvider>
          <Harness />
        </CycleCountProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(count!.lines).toHaveLength(1));
    act(() => count!.setCount(BATCH_LINE_KEY, '8'));
    await waitFor(() => expect(useCountDraftStore.getState().drafts[LOC.id]).toBeDefined());

    await expect(count!.authorise()).rejects.toThrow('disk full');
    expect(useCountDraftStore.getState().drafts[LOC.id]?.counts).toEqual({ [BATCH_LINE_KEY]: '8' });
  });
});
