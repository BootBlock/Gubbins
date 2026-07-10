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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditDayDialog } from './AuditDayDialog';
import { BurstProvider, type MediaQueryProvider } from '@/components/foundry';
import { useAuditSessionStore } from '../useAuditSessionStore';
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

const reconcileSpy = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const reconcileSerialisedSpy = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const markCountedSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../hooks', () => ({
  useReconcile: () => ({ mutateAsync: reconcileSpy, isPending: false }),
  useReconcileSerialised: () => ({ mutateAsync: reconcileSerialisedSpy, isPending: false }),
  useMarkLocationCounted: () => ({ mutateAsync: markCountedSpy, isPending: false }),
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

afterEach(() => {
  cleanup();
  // Reset the persisted session between tests.
  useAuditSessionStore.setState({ session: null });
  localStorage.clear();
  reconcileSpy.mockResolvedValue([]);
  reconcileSerialisedSpy.mockResolvedValue([]);
  markCountedSpy.mockResolvedValue(undefined);
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

    // Count 8 vs expected 10 → one variance → authorise it.
    reconcileSpy.mockResolvedValue([{ id: 'w1' }]);
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

    // Drawer B counts clean — mark counted and continue (no variance entered).
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

    // On Drawer B, mark counted.
    await waitFor(() => expect(screen.getByTestId('audit-step-heading').textContent).toContain('Drawer B'));
    await waitForCountInput();
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
    await act(async () => {
      fireEvent.click(screen.getByTestId('audit-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('audit-summary')).toBeTruthy());
    expect(screen.getByTestId('audit-stat-audited').textContent).toBe('2');
    expect(screen.getByTestId('audit-stat-variances').textContent).toBe('2');
    expect(screen.getByTestId('audit-stat-adjustments').textContent).toBe('2');
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
});
