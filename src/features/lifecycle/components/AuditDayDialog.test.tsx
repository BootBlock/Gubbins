/**
 * Component tests for the guided audit-day session flow (spec §4.4).
 *
 * Strategy mirrors CycleCountDialog.test: a real QueryClient (mocking
 * @tanstack/react-query crashes the worker pool) plus stubbed repositories, with the
 * reconcile mutations mocked at the `../hooks` boundary. The Tier-3 audit-session store is
 * the real persisted store, reset between tests so each starts clean.
 *
 * Coverage: scope → start → walk → progress advances → reconcile a location → final
 * summary; skip a location; a "choose specific locations" scope; and resuming a persisted
 * half-done session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditDayDialog } from './AuditDayDialog';
import { BurstProvider, type MediaQueryProvider } from '@/components/foundry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useAuditSessionStore } from '../useAuditSessionStore';
import { useCountDraftStore } from '../useCountDraftStore';
import { startAudit, markLocation } from '../audit-session';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Two walkable sibling locations. Tests exclude tsc, so a minimal node shape is fine.
const TREE = [
  { id: 'locA', name: 'Drawer A', isSystem: false, archivedAt: null, children: [] },
  { id: 'locB', name: 'Drawer B', isSystem: false, archivedAt: null, children: [] },
];

// Every location holds one discrete batch (Widget, expected 10) so entering a different
// count produces a variance; no serialised items.
const WIDGET_BATCH = {
  itemId: 'w1',
  name: 'Widget',
  batchKey: 'default',
  batchNumber: null,
  lotNumber: null,
  expiryDate: null,
  quantity: 10,
};
const COUNT_TESTID = `count-${WIDGET_BATCH.itemId}|${WIDGET_BATCH.batchKey}`;

vi.mock('@/db/repositories', () => ({
  getItemRepository: () => ({
    listStockBatchesAtLocation: () => Promise.resolve([WIDGET_BATCH]),
    list: () => Promise.resolve({ rows: [], hasMore: false, offset: 0, limit: 200 }),
  }),
  getLocationRepository: () => ({
    getTree: () => Promise.resolve(TREE),
  }),
}));

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

function renderDialog(onClose = () => {}) {
  return render(
    <QueryClientProvider client={makeClient()}>
      <AuditDayDialog open onClose={onClose} />
    </QueryClientProvider>,
  );
}

/** Wait for the current-location panel's count input to appear (query resolved). */
async function waitForCountInput() {
  await waitFor(() => expect(screen.getByTestId(COUNT_TESTID)).toBeTruthy());
}

// The completion burst is a flourish (off at the Balanced default); enable it so the fire-path
// tests exercise it. The OS reduced-motion side is injected per test via the BurstProvider.
beforeEach(() => usePreferencesStore.setState({ animationLevel: 'headache' }));
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ animationLevel: 'balanced' });
  // Reset the persisted session — and the saved count sheets (issue #587), or a count entered
  // by one test would be restored into the next one's walk.
  useAuditSessionStore.setState({ session: null });
  useCountDraftStore.setState({ drafts: {} });
  localStorage.clear();
  authoriseCountSpy.mockResolvedValue({ discrete: [], serialised: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuditDayDialog — scope picker', () => {
  it('defaults to "all locations" and previews the scope size', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-scope-count')).toBeTruthy());
    expect(screen.getByTestId('audit-scope-count').textContent).toContain('2 locations to walk');
    expect(screen.getByTestId('audit-start')).not.toHaveProperty('disabled', true);
  });

  it('"choose specific locations" narrows the scope to the ticked locations', async () => {
    renderDialog();
    // Wait for the tree query to resolve so the picker (not the spinner) is on screen.
    await waitFor(() => expect(screen.getByTestId('audit-scope-mode')).toBeTruthy());
    // Switch the mode Select to "selected" by clicking it open and choosing the option.
    fireEvent.click(screen.getByTestId('audit-scope-mode'));
    fireEvent.click(screen.getByText('Choose specific locations'));
    // Tick only Drawer B.
    await waitFor(() => expect(screen.getByTestId('audit-pick-locB')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-pick-locB'));
    expect(screen.getByTestId('audit-scope-count').textContent).toContain('1 location to walk');
  });
});

describe('AuditDayDialog — guided walk', () => {
  it('walks every location, reconciling one, and shows a final summary', async () => {
    renderDialog();

    // Start the walk over all (2) locations.
    await waitFor(() => expect(screen.getByTestId('audit-start')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-start'));

    // Location 1 of 2 — Drawer A.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer A'));
    expect(screen.getByTestId('audit-step-heading').textContent).toContain('Location 1 of 2');
    await waitForCountInput();

    // Count 8 vs expected 10 → one variance → authorise it. Every location's authorisation goes
    // through the one call now (it also stamps a clean location as counted), so the stub reports
    // an adjustment only when the call actually carries one — as the repository does.
    authoriseCountSpy.mockImplementation(async (input: { quantityAdjustments: readonly unknown[] }) => ({
      discrete: input.quantityAdjustments.length > 0 ? [{ id: 'w1' }] : [],
      serialised: [],
    }));
    fireEvent.change(screen.getByTestId(COUNT_TESTID), { target: { value: '8' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-authorise-continue'));
    });

    // Advanced to Location 2 of 2 — Drawer B.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer B'));
    expect(screen.getByTestId('audit-step-heading').textContent).toContain('Location 2 of 2');
    // The running tally reflects the one location with variances.
    expect(screen.getByTestId('audit-variance-tally').textContent).toContain('1 with variance');
    await waitForCountInput();

    // Drawer B counts clean — the expected 10 is entered and agrees, so the sheet is fully
    // covered and "Mark counted & continue" is offered. Leaving the line blank instead would
    // be a *partial* count, which is a different button and a different outcome (issue #637).
    fireEvent.change(screen.getByTestId(COUNT_TESTID), { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-continue'));
    });

    // Final summary.
    await waitFor(() => expect(screen.getByTestId('audit-summary')).toBeTruthy());
    expect(screen.getByTestId('audit-stat-audited').textContent).toBe('2');
    expect(screen.getByTestId('audit-stat-variances').textContent).toBe('1');
    expect(screen.getByTestId('audit-stat-adjustments').textContent).toBe('1');
    expect(screen.getByTestId('audit-stat-skipped').textContent).toBe('0');
    expect(screen.getByTestId('audit-summary-variances').textContent).toContain('Drawer A');
  });

  it('skips a location and records it in the summary', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-start')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-start'));

    // Skip Drawer A.
    await waitForCountInput();
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-skip'));
    });

    // On Drawer B, count the one line and mark it counted.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer B'));
    await waitForCountInput();
    fireEvent.change(screen.getByTestId(COUNT_TESTID), { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-continue'));
    });

    await waitFor(() => expect(screen.getByTestId('audit-summary')).toBeTruthy());
    expect(screen.getByTestId('audit-stat-audited').textContent).toBe('1');
    expect(screen.getByTestId('audit-stat-skipped').textContent).toBe('1');
    expect(screen.getByTestId('audit-summary-skipped').textContent).toContain('Drawer A');
  });

  it('announces the current step through the live region', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-start')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-start'));
    await waitFor(() =>
      expect(screen.getByTestId('audit-live-region').textContent).toContain('Now counting Drawer A'),
    );
  });
});

describe('AuditDayDialog — resume', () => {
  it('resumes a persisted half-done session on the first pending location', async () => {
    // Pre-seed a session: scope A + B, with A already reconciled and the persisted index
    // stale at 0. Opening should resume onto the first still-pending location (B).
    const seeded = markLocation(
      startAudit([
        { id: 'locA', name: 'Drawer A' },
        { id: 'locB', name: 'Drawer B' },
      ]),
      'locA',
      'reconciled',
      { variancesFound: 2, adjustmentsMade: 2 },
    );
    useAuditSessionStore.setState({ session: seeded });

    renderDialog();

    // Resumed straight onto Drawer B (location 2 of 2), not back at Drawer A.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer B'));
    expect(screen.getByTestId('audit-step-heading').textContent).toContain('Location 2 of 2');

    // Finish B → the summary carries A's already-recorded reconciliation.
    await waitForCountInput();
    fireEvent.change(screen.getByTestId(COUNT_TESTID), { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('audit-summary')).toBeTruthy());
    expect(screen.getByTestId('audit-stat-audited').textContent).toBe('2');
    expect(screen.getByTestId('audit-stat-variances').textContent).toBe('2');
    expect(screen.getByTestId('audit-stat-adjustments').textContent).toBe('2');
  });
});

describe('AuditDayDialog — "Pause & close" keeps the counts (issue #587)', () => {
  /** Start a walk over both locations and type `value` at Drawer A. */
  async function startAndCount(value: string) {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-start')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-start'));
    await waitForCountInput();
    fireEvent.change(screen.getByTestId(COUNT_TESTID), { target: { value } });
  }

  it('hands the counts back when the paused walk is resumed', async () => {
    await startAndCount('8');
    // Pause & close unmounts the dialog (as Escape and a backdrop tap also do) — this used to
    // throw away every quantity typed at the location in hand.
    fireEvent.click(screen.getByTestId('audit-pause'));
    cleanup();

    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer A'));
    await waitForCountInput();
    expect(screen.getByTestId<HTMLInputElement>(COUNT_TESTID).value).toBe('8');
    expect(screen.getByTestId('count-draft-notice').textContent).toContain('Restored 1 count');
  });

  it('shows no restore notice when the walk was paused before anything was typed', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-start')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-start'));
    await waitForCountInput();
    fireEvent.click(screen.getByTestId('audit-pause'));
    cleanup();

    renderDialog();
    await waitForCountInput();
    expect(screen.queryByTestId('count-draft-notice')).not.toBeInTheDocument();
    expect(useCountDraftStore.getState().drafts.locA).toBeUndefined();
  });

  it('drops a location’s sheet when it is skipped rather than counted', async () => {
    await startAndCount('8');
    expect(useCountDraftStore.getState().drafts.locA).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-skip'));
    });
    expect(useCountDraftStore.getState().drafts.locA).toBeUndefined();
  });

  it('discards every unfinished sheet in scope when the whole walk is abandoned', async () => {
    await startAndCount('8');
    expect(useCountDraftStore.getState().drafts.locA).toBeDefined();

    fireEvent.click(screen.getByTestId('audit-abandon'));
    expect(useCountDraftStore.getState().drafts).toEqual({});
    // …and the next stock-take starts from the scope picker with nothing carried over.
    await waitFor(() => expect(screen.getByTestId('audit-scope-count')).toBeTruthy());
  });

  it('keeps each location’s sheet to itself as the walk advances', async () => {
    await startAndCount('8');
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-authorise-continue'));
    });

    // Drawer B opens blind — Drawer A's count must not follow the walk to the next shelf.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer B'));
    await waitForCountInput();
    expect(screen.getByTestId<HTMLInputElement>(COUNT_TESTID).value).toBe('');
    expect(screen.queryByTestId('count-draft-notice')).not.toBeInTheDocument();
    // Drawer A's sheet was committed, so it is gone rather than waiting to be offered back.
    expect(useCountDraftStore.getState().drafts.locA).toBeUndefined();
  });
});

describe('AuditDayDialog — completion burst (F4)', () => {
  /** A reduced-motion provider reporting the given preference. */
  const motion =
    (matches: boolean): MediaQueryProvider =>
    () => ({
      matches,
      addEventListener() {},
      removeEventListener() {},
    });

  /** A session where every scoped location is reconciled — i.e. the walk is complete. */
  const completeSession = () =>
    markLocation(
      markLocation(
        startAudit([
          { id: 'locA', name: 'Drawer A' },
          { id: 'locB', name: 'Drawer B' },
        ]),
        'locA',
        'reconciled',
        {
          variancesFound: 0,
          adjustmentsMade: 0,
        },
      ),
      'locB',
      'reconciled',
      { variancesFound: 0, adjustmentsMade: 0 },
    );

  function renderWithBurst(reduced: boolean) {
    return render(
      <QueryClientProvider client={makeClient()}>
        <BurstProvider motionProvider={motion(reduced)} rng={() => 0.5}>
          <AuditDayDialog open onClose={() => {}} />
        </BurstProvider>
      </QueryClientProvider>,
    );
  }

  it('fires exactly one burst when a completed walk is shown', () => {
    useAuditSessionStore.setState({ session: completeSession() });
    renderWithBurst(false);
    expect(screen.getAllByTestId('burst')).toHaveLength(1);
  });

  it('does not re-fire when a completed walk is reopened (same session)', () => {
    useAuditSessionStore.setState({ session: completeSession() });
    const { rerender } = renderWithBurst(false);
    expect(screen.getAllByTestId('burst')).toHaveLength(1);

    // Close then reopen the still-complete session — the burst must not fire a second time.
    const tree = (open: boolean) => (
      <QueryClientProvider client={makeClient()}>
        <BurstProvider motionProvider={motion(false)} rng={() => 0.5}>
          <AuditDayDialog open={open} onClose={() => {}} />
        </BurstProvider>
      </QueryClientProvider>
    );
    rerender(tree(false));
    rerender(tree(true));
    expect(screen.getAllByTestId('burst')).toHaveLength(1);
  });

  it('renders no burst under reduced motion', () => {
    useAuditSessionStore.setState({ session: completeSession() });
    renderWithBurst(true);
    expect(screen.queryByTestId('burst')).not.toBeInTheDocument();
  });

  it('announces stock-take completion as text (the burst is decorative)', () => {
    useAuditSessionStore.setState({ session: completeSession() });
    // Even under reduced motion (no burst at all), the milestone must reach screen readers.
    renderWithBurst(true);
    expect(screen.getByTestId('audit-complete-live')).toHaveTextContent(
      'Stock-take complete. Walked 2 locations — 0 adjustments applied.',
    );
  });
});

// ---------------------------------------------------------------------------
// Partial coverage (issue #637)
// ---------------------------------------------------------------------------

describe('AuditDayDialog — a location finished with lines left blank', () => {
  it('records it as part-counted, keeping it out of the Audited tile', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('audit-start')).toBeTruthy());
    fireEvent.click(screen.getByTestId('audit-start'));

    // Drawer A: finish without typing anything. This used to be indistinguishable from a
    // shelf counted and found perfect — same button, same tile, same last-counted stamp.
    await waitForCountInput();
    expect(screen.getByTestId('audit-coverage').textContent).toBe('0 of 1 line counted');
    expect(screen.queryByTestId('audit-continue')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-partial-continue'));
    });
    expect(authoriseCountSpy).toHaveBeenCalledWith(expect.objectContaining({ markCounted: false }));
    expect(screen.getByTestId('audit-live-region').textContent).toContain('Partial count recorded');

    // Drawer B: counted properly.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer B'));
    await waitForCountInput();
    fireEvent.change(screen.getByTestId(COUNT_TESTID), { target: { value: '10' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-continue'));
    });

    await waitFor(() => expect(screen.getByTestId('audit-summary')).toBeTruthy());
    expect(screen.getByTestId('audit-stat-audited').textContent).toBe('1');
    expect(screen.getByTestId('audit-stat-partial').textContent).toBe('1');
    expect(screen.getByTestId('audit-summary-partial').textContent).toContain('Drawer A');
    expect(screen.getByTestId('audit-complete-live').textContent).toContain('1 location left part-counted');
  });
});
