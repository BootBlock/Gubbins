import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ItemHistoryEntry } from '@/db/repositories';
import type { Authority } from '@/features/users/permissions';

/**
 * The per-item Activity Log's controls (issue #620) — Export and Clear.
 *
 * The log body itself is virtualised and covered end-to-end by the browser smoke run; what
 * these pin is the toolbar's own contract, which is where the judgement calls are: who is
 * allowed to see a Clear button at all, that destroying an audit trail is confirmed rather
 * than done on the first click, and that the entry the clear leaves behind names whoever
 * asked for it. The repository, query and export seams are mocked per the component-test
 * conventions — a component test has no QueryClient, worker or toast provider.
 */

const h = vi.hoisted(() => ({
  entries: [] as ItemHistoryEntry[],
  isLoading: false,
  clear: vi.fn(),
  clearPending: false,
  clearError: false,
  authority: { mode: 'unrestricted' } as Authority,
  displayName: null as string | null,
  exportDisabled: undefined as boolean | undefined,
}));

vi.mock('../queries', () => ({
  useItemHistory: () => ({
    data: { pages: [{ rows: h.entries, offset: 0 }] },
    isLoading: h.isLoading,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    fetchPreviousPage: vi.fn(),
    hasPreviousPage: false,
    isFetchingPreviousPage: false,
  }),
  readItemHistoryPage: () => vi.fn(),
}));

vi.mock('../mutations', () => ({
  useClearItemHistory: () => ({
    mutate: h.clear,
    isPending: h.clearPending,
    isError: h.clearError,
  }),
}));

vi.mock('@/state/stores/useSessionStore', () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({ authority: h.authority, session: h.displayName ? { displayName: h.displayName } : null }),
}));

// The shared export menu is exercised by its own tests; here it only has to report the one
// thing this toolbar decides about it — whether it is offered at all.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: (props: { disabled?: boolean; triggerLabel: string }) => {
    h.exportDisabled = props.disabled;
    return (
      <button type="button" disabled={props.disabled} data-testid="export-item-activity">
        {props.triggerLabel}
      </button>
    );
  },
}));

vi.mock('@/lib/env/device-id', () => ({ getDeviceId: () => 'abcdef01-2345-4000-8000-000000000000' }));

import { ActivityLog } from './ActivityLog';

const ITEM_ID = 'item-1';

/** Synthetic, COMPLETE ledger fixture (tests are excluded from tsc). */
const entry = (overrides: Partial<ItemHistoryEntry> = {}): ItemHistoryEntry => ({
  id: 'h1',
  itemId: ITEM_ID,
  action: 'CREATED',
  quantityDelta: null,
  netValueDelta: null,
  note: 'Item created.',
  metadata: null,
  createdAt: Date.parse('2026-07-25T09:30:00Z'),
  ...overrides,
});

const renderLog = () => render(<ActivityLog itemId={ITEM_ID} itemName="Brass widget" />);
const clearButton = () => screen.getByTestId('clear-item-activity');

beforeEach(() => {
  h.entries = [entry()];
  h.isLoading = false;
  h.clear.mockReset();
  h.clearPending = false;
  h.clearError = false;
  h.authority = { mode: 'unrestricted' };
  h.displayName = null;
  h.exportDisabled = undefined;
});
afterEach(cleanup);

describe('ActivityLog controls — availability', () => {
  it('offers both controls when there is a log to act on', () => {
    renderLog();
    expect(screen.getByTestId('export-item-activity')).toBeEnabled();
    expect(clearButton()).toBeEnabled();
  });

  it('disables both on an empty log — there is nothing to export or clear', () => {
    h.entries = [];
    renderLog();
    expect(h.exportDisabled).toBe(true);
    expect(clearButton()).toBeDisabled();
    expect(screen.getByText('No activity recorded yet.')).toBeInTheDocument();
  });

  it('disables both while the first page is still loading, not just when it is empty', () => {
    // Entries present *and* still loading, so only the loading guard can be what disables them —
    // an empty fixture here would pass on the empty branch alone and prove nothing. The state is
    // reachable: an invalidated log refetches with the previous page still in the cache, and a
    // toolbar live at that moment would export a half-read ledger.
    h.entries = [entry()];
    h.isLoading = true;
    renderLog();
    expect(h.exportDisabled).toBe(true);
    expect(clearButton()).toBeDisabled();
  });

  it('hides Clear from a user without audit:delete, keeping Export', () => {
    // Destroying an audit trail is a bigger deal than reading one: a role that may see the log
    // must not be offered a control it would only be refused on.
    h.authority = { mode: 'granted', grants: new Set(['items:read', 'items:write']) };
    renderLog();
    expect(screen.queryByTestId('clear-item-activity')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-item-activity')).toBeInTheDocument();
  });

  it('shows Clear to a role granted audit:delete', () => {
    h.authority = { mode: 'granted', grants: new Set(['audit:delete']) };
    renderLog();
    expect(clearButton()).toBeInTheDocument();
  });
});

describe('ActivityLog controls — clearing', () => {
  it('confirms first: the first click only opens the dialog', () => {
    renderLog();
    fireEvent.click(clearButton());
    expect(h.clear).not.toHaveBeenCalled();
    expect(screen.getByText('Clear this activity log?')).toBeInTheDocument();
    // The item is named, so there is no doubt about what is being cleared.
    expect(screen.getByText(/Brass widget/)).toBeInTheDocument();
  });

  it('records the signed-in user as who cleared it', () => {
    h.displayName = 'Ada Lovelace';
    renderLog();
    fireEvent.click(clearButton());
    fireEvent.click(screen.getByTestId('confirm-clear-item-activity'));
    expect(h.clear).toHaveBeenCalledWith(
      { id: ITEM_ID, clearedBy: 'Ada Lovelace' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('records the device when nobody is signed in', () => {
    renderLog();
    fireEvent.click(clearButton());
    fireEvent.click(screen.getByTestId('confirm-clear-item-activity'));
    expect(h.clear).toHaveBeenCalledWith(
      expect.objectContaining({ clearedBy: 'device abcdef01' }),
      expect.anything(),
    );
  });

  it('cancels without clearing', () => {
    renderLog();
    fireEvent.click(clearButton());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.clear).not.toHaveBeenCalled();
    expect(screen.queryByText('Clear this activity log?')).not.toBeInTheDocument();
  });

  it('says so when the clear fails, rather than closing as if it worked', () => {
    h.clearError = true;
    renderLog();
    fireEvent.click(clearButton());
    expect(screen.getByTestId('clear-item-activity-error')).toHaveAttribute('role', 'alert');
  });
});
