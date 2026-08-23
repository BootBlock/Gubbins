/**
 * Issue #631: the Sync screen re-resolves the session's permissions whenever rows arrive.
 *
 * `users`, `roles` and `api_tokens` sync like any other table, so a role narrowed, an account
 * disabled or an account deleted on another device reaches this one through a merge, a backup
 * restore or a conflict restore. None of those touch the local admin screens, and the sign-in
 * gate's effect is keyed on the module flag and the session's user id — neither of which
 * changes — so nothing else re-runs. Without the refresh below the device keeps writing under
 * the permissions it signed in with until it is reloaded.
 *
 * The refresh itself is pinned in `features/users/authority-refresh.test.ts`; this file is
 * about the three places the screen has to call it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { useSyncConflictsStore } from './conflict-store';
import type { SyncResult } from './sync-engine';

// --- mocks ------------------------------------------------------------------
// The screen's IO boundaries, as in `SyncScreen.push-failure.test.tsx`. The two restore dialogs
// are stubbed as a single button each so their callbacks can be fired without driving a real
// restore, which is what those features' own tests cover.
const mockRunSync = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SyncResult>>());
const mockAdoptAuthorityChange = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateQueries = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('./sync-engine', () => ({ runSync: mockRunSync }));
vi.mock('@/features/users/authority-refresh', () => ({
  adoptAuthorityChange: mockAdoptAuthorityChange,
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('@/features/settings/settings-sync-runtime', () => ({
  applySharedSettings: vi.fn().mockResolvedValue(0),
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
vi.mock('@/features/backup/BackupDialog', () => ({
  BackupDialog: ({ onRestored }: { onRestored?: (notice: { message: string; tone: 'info' }) => void }) => (
    <button type="button" onClick={() => onRestored?.({ message: 'Restored.', tone: 'info' })}>
      fire backup restore
    </button>
  ),
}));
vi.mock('@/features/backup/restore-backup', () => ({ consumeRestoreNotice: () => null }));
vi.mock('@/features/backup/SettingsGroupPicker', () => ({ SettingsGroupPicker: () => null }));
vi.mock('./SyncConflictsDialog', () => ({
  SyncConflictsDialog: ({ onRestored }: { onRestored?: () => void }) => (
    <button type="button" onClick={() => onRestored?.()}>
      fire conflict restore
    </button>
  ),
}));
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

/** A merge that landed and published, with nothing else to report. */
function mergedOutcome(): SyncResult {
  return {
    status: 'OK',
    pulled: 1,
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
    conflicts: [],
  } as SyncResult;
}

describe('SyncScreen — permissions are re-resolved when rows arrive (#631)', () => {
  beforeEach(() => {
    mockRunSync.mockReset();
    mockAdoptAuthorityChange.mockClear();
    mockInvalidateQueries.mockClear();
    useSyncConflictsStore.setState({ conflicts: [] });
    useAuthStore.setState({ providerId: 'memory', providerLabel: 'In-memory', lastSyncedAt: 5000 });
  });

  afterEach(cleanup);

  it('re-resolves after a merge, so a role change from another device takes effect', async () => {
    mockRunSync.mockResolvedValue(mergedOutcome());
    render(<SyncScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(mockAdoptAuthorityChange).toHaveBeenCalled());
  });

  it('re-resolves after a reload-free backup restore', async () => {
    render(<SyncScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /fire backup restore/i }));

    await waitFor(() => expect(mockAdoptAuthorityChange).toHaveBeenCalled());
  });

  it('re-resolves after a conflict restore', async () => {
    render(<SyncScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /fire conflict restore/i }));

    await waitFor(() => expect(mockAdoptAuthorityChange).toHaveBeenCalled());
  });

  it('leaves a failed sync alone — nothing was adopted, so nothing is re-resolved', async () => {
    mockRunSync.mockRejectedValue(new Error('Failed to fetch'));
    render(<SyncScreen />);
    await userEvent.click(await screen.findByRole('button', { name: /sync now/i }));

    await screen.findByTestId('sync-error');
    expect(mockAdoptAuthorityChange).not.toHaveBeenCalled();
  });
});
