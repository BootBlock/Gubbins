import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Behaviour tests for {@link SyncConflictsDialog} (issue #72). Pins the contract: a recorded
 * collision renders with its field diff; "Keep current" resolves it without touching the DB;
 * "Use my version" calls the restore seam then resolves and notifies the host; and a failed
 * restore surfaces the error while leaving the conflict in place. Per the component-test
 * conventions the DB-touching restore seam and the sync driver are mocked; the real
 * device-local store and pure diff run for real.
 */

const h = vi.hoisted(() => ({ restore: vi.fn() }));

vi.mock('./conflict-restore', () => ({ restoreConflictVersion: h.restore }));
vi.mock('./runtime', () => ({ getSyncDriver: () => ({}) }));

import { SyncConflictsDialog } from './SyncConflictsDialog';
import { useSyncConflictsStore } from './conflict-store';
import { buildConflict } from './conflict-detect';

const onClose = vi.fn();
const onRestored = vi.fn();

function seedUpdate() {
  useSyncConflictsStore.getState().add([
    buildConflict(
      'contacts',
      { id: 'c1', name: 'Ada', updated_at: 150 },
      { id: 'c1', name: 'Grace', updated_at: 200 },
      // Freshly detected: the store ages stale conflicts out relative to the wall clock (#373).
      Date.now(),
    ),
  ]);
}

beforeEach(() => {
  useSyncConflictsStore.getState().clear();
  h.restore.mockReset().mockResolvedValue(undefined);
  onClose.mockReset();
  onRestored.mockReset();
});
afterEach(cleanup);

describe('SyncConflictsDialog (#72)', () => {
  it('renders a conflict with its field diff', () => {
    seedUpdate();
    render(<SyncConflictsDialog open onClose={onClose} onRestored={onRestored} />);
    expect(screen.getAllByText('Ada').length).toBeGreaterThanOrEqual(1); // label + diff value
    expect(screen.getByText('Grace')).toBeInTheDocument(); // the winning value
    expect(screen.getByText('Name')).toBeInTheDocument(); // humanised column
  });

  it('"Keep current" resolves the conflict without restoring', () => {
    seedUpdate();
    render(<SyncConflictsDialog open onClose={onClose} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: /Keep current/ }));
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(0);
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('"Use my version" restores, resolves, and notifies the host', async () => {
    seedUpdate();
    render(<SyncConflictsDialog open onClose={onClose} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: /Use my version/ }));

    await waitFor(() => expect(h.restore).toHaveBeenCalledTimes(1));
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(0);
    expect(onRestored).toHaveBeenCalled();
  });

  it('a failed restore surfaces the error and keeps the conflict', async () => {
    h.restore.mockRejectedValue(new Error('A parent it referenced is gone.'));
    seedUpdate();
    render(<SyncConflictsDialog open onClose={onClose} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('button', { name: /Use my version/ }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('A parent it referenced is gone.'),
    );
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(1);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('shows an empty state when there is nothing to review', () => {
    render(<SyncConflictsDialog open onClose={onClose} />);
    expect(screen.getByTestId('conflicts-empty')).toBeInTheDocument();
  });
});
