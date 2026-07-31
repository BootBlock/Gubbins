/**
 * Issue #638: what the Sync screen does when the merge lands but the push does not.
 *
 * The engine half is pinned in `push-failure-recovery.test.ts`; this is the half the user
 * actually experiences. Everything that does *not* depend on the upload succeeding has to
 * happen anyway — the conflict records are persisted (they are unrecoverable otherwise, since
 * the local edits they describe have already been overwritten), the query cache is invalidated
 * (every screen is otherwise rendering rows the merge has just changed or deleted), and the
 * message says which half failed rather than "Sync failed", which reads as "nothing happened".
 *
 * The one thing that must *not* happen is `markSynced` — the shared copy was never updated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { useSyncConflictsStore } from './conflict-store';
import { SyncPushFailedError } from './sync-errors';
import type { SyncConflict } from './types';
import type { SyncResult } from './sync-engine';

// --- mocks ------------------------------------------------------------------
// The screen's IO boundaries: the sync pass itself, the query cache, the provider transports,
// and the dialogs/panels it hosts. None of them are what this file is about.
const mockRunSync = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SyncResult>>());
const mockInvalidateQueries = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockApplySharedSettings = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock('./sync-engine', () => ({ runSync: mockRunSync }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('@/features/settings/settings-sync-runtime', () => ({
  applySharedSettings: mockApplySharedSettings,
  flushSettingsSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./runtime', () => ({
  getActiveProvider: () => ({ id: 'memory', label: 'In-memory (test)' }),
  getSyncDriver: () => ({}),
  setActiveProvider: vi.fn(),
}));
vi.mock('./providers/file-system-provider', () => ({
  connectFileSystemProvider: vi.fn(),
  forgetFileSystemProvider: vi.fn(),
  reconnectFileSystemProvider: vi.fn().mockResolvedValue({ provider: null, needsGesture: false }),
}));
vi.mock('./providers/google-drive-provider', () => ({
  connectGoogleDrive: vi.fn(),
  forgetGoogleDrive: vi.fn(),
  reconnectGoogleDrive: () => ({ provider: null, needsAuth: false }),
}));
vi.mock('./providers/google-config', () => ({ isGoogleDriveConfigured: () => false }));
vi.mock('./providers/google-oauth', () => ({ consumeGoogleAuthError: () => null }));
vi.mock('./push-to-bridge', () => ({
  buildPushSnapshotJson: vi.fn(),
  pushSnapshotToBridge: vi.fn(),
}));
vi.mock('./bridge-build-check', () => ({ checkBridgeBuild: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/backup/BackupDialog', () => ({ BackupDialog: () => null }));
vi.mock('@/features/backup/restore-backup', () => ({ consumeRestoreNotice: () => null }));
vi.mock('@/features/backup/SettingsGroupPicker', () => ({ SettingsGroupPicker: () => null }));
vi.mock('./SyncConflictsDialog', () => ({ SyncConflictsDialog: () => null }));
vi.mock('./BridgeReloadNotice', () => ({ BridgeReloadNotice: () => null }));
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" aria-label="Navigation menu" />,
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    date: (d: number) => String(d),
    dateTime: (d: number) => String(d),
    number: (n: number) => String(n),
    currency: (n: number) => String(n),
    currencyParts: () => ({ prefix: '', digits: '0', suffix: '' }),
    bytes: (n: number) => `${n} B`,
  }),
}));
vi.mock('@/lib/env/feature-detection', () => ({ hasFileSystemAccess: () => false }));

// Imported after the mocks so the screen picks them up.
const { SyncScreen } = await import('./SyncScreen');

/**
 * An overwritten local edit, as the merge reports one. Detected *now*: the store ages its
 * backlog out (#373), so an epoch-era stamp would be discarded on arrival.
 */
const CONFLICT: SyncConflict = {
  id: 'contacts:c1',
  tableName: 'contacts',
  rowId: 'c1',
  kind: 'UPDATE',
  localVersion: { id: 'c1', name: 'My edit' },
  remoteVersion: { id: 'c1', name: 'Their edit' },
  entityLabel: 'My edit',
  detectedAt: Date.now(),
};

/** The half-completed pass the engine hands out when the upload fails after the merge. */
function pushFailure(overrides: Partial<SyncResult> = {}): SyncPushFailedError {
  return new SyncPushFailedError(
    'publishing failed',
    {
      status: 'MERGED_NOT_PUBLISHED',
      pulled: 2,
      deleted: 0,
      reparented: 0,
      rejectedCycles: 0,
      serialisedLoansClosed: 0,
      bookingsCancelled: 0,
      prunedTombstones: 0,
      clockOffset: 0,
      historyInserted: 0,
      tagEdgesAdded: 0,
      tagEdgesRemoved: 0,
      conflicts: [CONFLICT],
      ...overrides,
    },
    { cause: new Error('Failed to fetch') },
  );
}

async function syncNow() {
  render(<SyncScreen />);
  await userEvent.click(await screen.findByRole('button', { name: /sync now/i }));
}

describe('SyncScreen — a merge whose push failed (#638)', () => {
  beforeEach(() => {
    mockRunSync.mockReset();
    mockInvalidateQueries.mockClear();
    mockApplySharedSettings.mockClear();
    useSyncConflictsStore.setState({ conflicts: [] });
    useAuthStore.setState({ providerId: 'memory', providerLabel: 'In-memory', lastSyncedAt: 5000 });
  });

  afterEach(cleanup);

  it('keeps the conflict records the merge produced', async () => {
    mockRunSync.mockRejectedValue(pushFailure());
    await syncNow();

    await waitFor(() => expect(useSyncConflictsStore.getState().conflicts).toHaveLength(1));
    expect(useSyncConflictsStore.getState().conflicts[0]!.id).toBe(CONFLICT.id);
  });

  it('refreshes the caches, so no screen keeps rendering rows the merge changed', async () => {
    mockRunSync.mockRejectedValue(pushFailure());
    await syncNow();

    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalled());
    // The merge also resolved every shared preference; those values are already in the database.
    expect(mockApplySharedSettings).toHaveBeenCalled();
  });

  it('says the merge landed and the publish did not, rather than "Sync failed"', async () => {
    mockRunSync.mockRejectedValue(pushFailure());
    await syncNow();

    const banner = await screen.findByTestId('sync-error');
    expect(banner).toHaveTextContent(/merged and saved on this device/i);
    expect(banner).not.toHaveTextContent(/^Sync failed\.$/);
  });

  it('does not claim the device is up to date with the shared copy', async () => {
    mockRunSync.mockRejectedValue(pushFailure());
    await syncNow();

    await waitFor(() => expect(mockInvalidateQueries).toHaveBeenCalled());
    // `markSynced` would move this on; the push never landed, so it must not.
    expect(useAuthStore.getState().lastSyncedAt).toBe(5000);
  });

  it('still adopts the local half when the upload failed on an expired token', async () => {
    // The auth branch owns the message (reconnecting is the actionable fix), but the merge is
    // just as committed, so its conflicts and the cache refresh must not be skipped.
    const { GoogleApiError } = await import('./providers/google-drive-api');
    const expired = new SyncPushFailedError('publishing failed', pushFailure().localOutcome, {
      cause: new GoogleApiError(401, 'Unauthorized'),
    });
    mockRunSync.mockRejectedValue(expired);
    await syncNow();

    await waitFor(() => expect(useSyncConflictsStore.getState().conflicts).toHaveLength(1));
    expect(mockInvalidateQueries).toHaveBeenCalled();
    expect(await screen.findByTestId('sync-error')).toHaveTextContent(/sign-in expired/i);
  });

  it('leaves an ordinary failure reported as one, with nothing adopted', async () => {
    mockRunSync.mockRejectedValue(new Error('Failed to fetch'));
    await syncNow();

    await screen.findByTestId('sync-error');
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(0);
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});
