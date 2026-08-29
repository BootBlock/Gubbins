/**
 * Component tests for CycleCountDialog — focused on the WCAG 4.1.3 aria-live
 * announcement of the reconciliation result (Phase 63).
 *
 * Strategy: use a real QueryClient + QueryClientProvider (no @tanstack/react-query
 * mock — mocking that module crashes the vitest threads-pool worker) and stub the
 * repository so the query resolves to a known location with one discrete item.
 * The reconcile hooks are mocked at the `../hooks` boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// What the location holds. Mutable so one test can render a location the database believes is
// empty — where misplaced stock is most likely to turn up, and where the sheet used to offer
// nothing at all (issue #640).
const stock = vi.hoisted(() => ({ batches: [] as unknown[] }));

vi.mock('@/db/repositories', () => ({
  getItemRepository: () => ({
    listStockBatchesAtLocation: () => Promise.resolve(stock.batches),
    listSerialisedAtLocation: () => Promise.resolve([]),
  }),
}));

// Reconcile hooks — spies resolved with [] by default; individual tests override.
const authoriseCountSpy = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ discrete: [], serialised: [], relocated: [] }),
);

vi.mock('../hooks', () => ({
  useAuthoriseCount: () => ({ mutateAsync: authoriseCountSpy, isPending: false }),
}));

// The "found something that isn't listed?" control reads the item catalogue, which this file
// stubs the repository for — so it is replaced with two buttons that add a known find of each
// tracking mode. Its own picker behaviour is covered in `FoundHereField.test.tsx`; what these
// tests need is a deterministic way to put a find on the sheet (issue #640).
const FOUND_BULK = { itemId: 'found-bulk', name: 'Loose screws', serialNo: null, mode: 'DISCRETE' } as const;
const FOUND_UNIT = { itemId: 'found-unit', name: 'Multimeter', serialNo: 3, mode: 'SERIALISED' } as const;

vi.mock('./FoundHereField', () => ({
  FoundHereField: ({ count }: { count: LocationCycleCount }) => (
    <div>
      <button type="button" onClick={() => count.addFound(FOUND_BULK)}>
        add found bulk
      </button>
      <button type="button" onClick={() => count.addFound(FOUND_UNIT)}>
        add found unit
      </button>
    </div>
  ),
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

beforeEach(() => {
  stock.batches = [ONE_BATCH];
});

afterEach(() => {
  cleanup();
  authoriseCountSpy.mockResolvedValue({ discrete: [], serialised: [], relocated: [] });
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
    authoriseCountSpy.mockResolvedValue({ discrete: [fakeItem, fakeItem], serialised: [], relocated: [] });

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
    authoriseCountSpy.mockResolvedValue({ discrete: [{ id: 'item-abc' }], serialised: [], relocated: [] });

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
    authoriseCountSpy.mockResolvedValue({ discrete: [{ id: 'item-abc' }], serialised: [], relocated: [] });

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
        [LOC.id]: {
          counts: { [BATCH_LINE_KEY]: '8' },
          missing: [],
          found: [],
          savedAt: Date.now() - 3 * 86_400_000,
        },
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('count-draft-notice')).toBeTruthy());
    expect(screen.getByTestId('count-draft-notice').textContent).toContain('entered here 3 days ago');
  });

  it('does not restamp a sheet just for opening it, even when a dead line is pruned away', async () => {
    // The age is the load-bearing part of the notice — it is what the wiki tells the auditor to
    // judge "check the shelf before authorising" by. Opening a location re-seeds the sheet, and
    // if a lot has been consumed since, the restore prunes its count; that makes the sheet's
    // content differ from the stored copy, so a blind mirror would write it back stamped *now*
    // and the next visit would call a days-old count "just now".
    const threeDaysAgo = Date.now() - 3 * 86_400_000;
    useCountDraftStore.setState({
      drafts: {
        [LOC.id]: {
          counts: { [BATCH_LINE_KEY]: '8', 'gone-lot|default': '3' },
          missing: [],
          savedAt: threeDaysAgo,
        },
      },
    });

    renderDialog();
    // The pruned line is gone from the sheet the auditor sees…
    await waitFor(() => expect(screen.getByTestId('count-draft-notice')).toBeTruthy());
    expect(screen.getByTestId('count-draft-notice').textContent).toContain('Restored 1 count');
    expect(screen.getByTestId('count-draft-notice').textContent).toContain('3 days ago');

    // …and merely looking at the location has not aged the stored sheet forward.
    expect(useCountDraftStore.getState().drafts[LOC.id]?.savedAt).toBe(threeDaysAgo);
  });

  it('does restamp once the auditor actually enters something', async () => {
    const threeDaysAgo = Date.now() - 3 * 86_400_000;
    useCountDraftStore.setState({
      drafts: {
        [LOC.id]: { counts: { [BATCH_LINE_KEY]: '8' }, missing: [], found: [], savedAt: threeDaysAgo },
      },
    });

    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), { target: { value: '9' } });

    await waitFor(() =>
      expect(useCountDraftStore.getState().drafts[LOC.id]?.counts).toEqual({ [BATCH_LINE_KEY]: '9' }),
    );
    expect(useCountDraftStore.getState().drafts[LOC.id]!.savedAt).toBeGreaterThan(threeDaysAgo);
  });

  it('says "earlier" rather than inventing a date when the stored stamp was unusable', async () => {
    useCountDraftStore.setState({
      drafts: { [LOC.id]: { counts: { [BATCH_LINE_KEY]: '8' }, missing: [], found: [], savedAt: null } },
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
    authoriseCountSpy.mockResolvedValue({ discrete: [{ id: 'item-abc' }], serialised: [], relocated: [] });
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

// ---------------------------------------------------------------------------
// Partial coverage (issue #637)
// ---------------------------------------------------------------------------

describe('CycleCountDialog — a sheet with lines left blank', () => {
  it('says how much is counted and refuses to offer "Mark counted"', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    // Nothing typed: the adjustment count alone reads identically to a perfect count, so the
    // coverage line and the notice are what separate the two.
    expect(screen.getByTestId('cycle-count-coverage').textContent).toBe('0 of 1 line counted');
    expect(screen.getByTestId('count-coverage-notice').textContent).toContain('1 of 1 line not counted');
    expect(screen.getByTestId('authorise-reconciliation').textContent).toContain('Record partial count');
  });

  it('does not stamp the location as counted, and says so afterwards', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    // The durable last-counted stamp is the whole point: a shelf nobody counted must not be
    // removed from the list of shelves needing a count.
    expect(authoriseCountSpy).toHaveBeenCalledWith(expect.objectContaining({ markCounted: false }));
    const region = screen.getByTestId('cycle-count-result');
    expect(region.textContent).toContain('Partial count recorded');
    expect(region.textContent).toContain('0 of 1 line counted');
    expect(region.textContent).toContain('has not been marked as counted');
    expect(region.textContent).not.toContain('recorded as counted.');
  });

  it('a fully-counted clean sheet still stamps and still says "recorded as counted"', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());

    // The expected 10, entered — a real clean count, which must keep the old behaviour.
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), { target: { value: '10' } });
    expect(screen.queryByTestId('count-coverage-notice')).toBeNull();
    expect(screen.getByTestId('authorise-reconciliation').textContent).toContain('Mark counted');

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    expect(authoriseCountSpy).toHaveBeenCalledWith(expect.objectContaining({ markCounted: true }));
    expect(screen.getByTestId('cycle-count-result').textContent).toContain(
      'No variances found — recorded as counted.',
    );
  });
});

// ---------------------------------------------------------------------------
// Found here (issue #640)
// ---------------------------------------------------------------------------

describe('CycleCountDialog — recording stock found where it was not expected', () => {
  const addFoundBulk = () => fireEvent.click(screen.getByRole('button', { name: 'add found bulk' }));
  const addFoundUnit = () => fireEvent.click(screen.getByRole('button', { name: 'add found unit' }));

  it('adds a count line expecting zero, so what is counted against it is a surplus here', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    act(addFoundBulk);

    const found = await screen.findByTestId(`count-${FOUND_BULK.itemId}|`);
    fireEvent.change(found, { target: { value: '12' } });
    // Twelve counted against an expectation of none is a variance of +12, not a clean line.
    expect(screen.getByLabelText(`Counted quantity for ${FOUND_BULK.name}`)).toBe(found);
    const sheet = screen.getByTestId('cycle-count-lines').textContent ?? '';
    expect(sheet).toContain('+12');
    // And the row says why it is on a sheet that is otherwise everything the database expects.
    expect(sheet).toContain('Found here');
  });

  it('authorises the find as an adjustment at this placement, leaving the shelf it left alone', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    act(addFoundBulk);
    fireEvent.change(await screen.findByTestId(`count-${FOUND_BULK.itemId}|`), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), { target: { value: '10' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    // The adjustment names this location and the untracked lot, which is the branch that seeds a
    // placement the item has never held — the whole point of the expected-zero line.
    expect(authoriseCountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        quantityAdjustments: expect.arrayContaining([
          expect.objectContaining({
            itemId: FOUND_BULK.itemId,
            counted: 12,
            locationId: LOC.id,
            batch: { batchNumber: null, lotNumber: null, expiryDate: null },
          }),
        ]),
      }),
    );
  });

  it('sends a found serialised unit as a relocation, never as a missing-instance retirement', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    act(addFoundUnit);
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), { target: { value: '10' } });

    await waitFor(() => expect(screen.getByTestId('found-serialised-lines')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('authorise-reconciliation'));
    });

    expect(authoriseCountSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        relocations: [
          {
            itemId: FOUND_UNIT.itemId,
            note: `Serialised audit of ${LOC.name}: ${FOUND_UNIT.name} #3 found here — moved from its recorded location.`,
          },
        ],
        // Retiring it is the opposite correction: the unit is not missing, it is right here.
        serialisedAdjustments: [],
      }),
    );
  });

  it('counts a find towards the sheet’s coverage, so an untouched addition blocks "Mark counted"', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    fireEvent.change(screen.getByTestId(`count-${BATCH_LINE_KEY}`), { target: { value: '10' } });
    expect(screen.getByTestId('authorise-reconciliation').textContent).toContain('Mark counted');

    act(addFoundBulk);

    // The auditor added a line and has not answered it. That is exactly the part-counted sheet
    // issue #637 refuses to record as a completed count.
    await waitFor(() =>
      expect(screen.getByTestId('cycle-count-coverage').textContent).toBe('1 of 2 lines counted'),
    );
    expect(screen.getByTestId('authorise-reconciliation').textContent).toContain('Record partial count');
  });

  it('takes a find back off the sheet, and the quantity typed against it with it', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    act(addFoundBulk);
    fireEvent.change(await screen.findByTestId(`count-${FOUND_BULK.itemId}|`), { target: { value: '12' } });

    fireEvent.click(screen.getByTestId(`remove-found-${FOUND_BULK.itemId}`));

    await waitFor(() => expect(screen.queryByTestId(`count-${FOUND_BULK.itemId}|`)).toBeNull());
    // Adding it again must not resurrect a count the auditor has since taken back.
    act(addFoundBulk);
    expect((await screen.findByTestId(`count-${FOUND_BULK.itemId}|`)).getAttribute('value')).toBe('');
  });

  it('keeps a find across a close and reopen, like any other work on the sheet', async () => {
    const client = makeClient();
    const first = renderDialog(client);
    await waitFor(() => expect(screen.getByTestId(`count-${BATCH_LINE_KEY}`)).toBeTruthy());
    act(addFoundBulk);
    fireEvent.change(await screen.findByTestId(`count-${FOUND_BULK.itemId}|`), { target: { value: '12' } });
    await waitFor(() => expect(useCountDraftStore.getState().drafts[LOC.id]?.found).toHaveLength(1));

    first.unmount();
    renderDialog(client);

    // Noticing the units is the work — a sheet that forgot the find would send the auditor back
    // to the shelf with nothing on screen saying there was ever anything to find.
    const restored = await screen.findByTestId(`count-${FOUND_BULK.itemId}|`);
    expect(restored.getAttribute('value')).toBe('12');
  });

  it('offers the control in a location the database believes is empty', async () => {
    stock.batches = [];
    renderDialog();
    await waitFor(() =>
      expect(screen.getByText('No countable items in this location to audit.')).toBeTruthy(),
    );

    // An empty drawer is exactly where a misplaced box turns up, and the sheet that says there is
    // nothing here is the one with no line to record it on.
    act(addFoundBulk);
    const found = await screen.findByTestId(`count-${FOUND_BULK.itemId}|`);
    fireEvent.change(found, { target: { value: '12' } });
    // Adding a line makes the location countable, so the ordinary counting footer takes over.
    expect(screen.getByTestId('authorise-reconciliation').textContent).toContain('Authorise (1)');
  });
});
