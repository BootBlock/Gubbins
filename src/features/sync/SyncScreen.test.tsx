/**
 * Issue #429: which of the Sync screen's controls a role is actually offered.
 *
 * The route admits `sync:read` **or** either backup key, because Backup & restore lives on this
 * screen rather than one of its own. That makes the screen reachable by three quite different
 * roles, and the controls on it have to answer to their own keys rather than to the route's.
 *
 * The read-only half — connection status, last-synced line, the bridge's own explanation — is
 * deliberately not asserted as hidden here: it reports, it does not act.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { useSyncConflictsStore } from './conflict-store';
import { SyncRemoteMissingError } from './sync-errors';
import type { SyncResult } from './sync-engine';

// --- mocks ------------------------------------------------------------------
// The screen's IO boundaries, as in `SyncScreen.authority-refresh.test.tsx`.
const mockRunSync = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<SyncResult>>());

vi.mock('./sync-engine', () => ({ runSync: mockRunSync }));
vi.mock('@/features/users/authority-refresh', () => ({
  adoptAuthorityChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
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

/** Sign in with exactly these grants, as a restricted account resolves to. */
function signInWith(grants: readonly string[]): void {
  useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(grants) } });
}

beforeEach(() => {
  mockRunSync.mockReset();
  useSyncConflictsStore.setState({ conflicts: [] });
  useAuthStore.setState({ providerId: 'memory', providerLabel: 'In-memory', lastSyncedAt: 5000 });
  // A configured bridge, so "Push now" is held back by the permission rather than by an empty field.
  usePreferencesStore.setState({
    bridgeUrl: 'http://localhost:8787',
    bridgeToken: 'placeholder-token',
  });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

describe('SyncScreen — driving a sync is `sync:write` (issue #429)', () => {
  it('offers "Sync now" in single-user mode, where every session is unrestricted', () => {
    render(<SyncScreen />);
    expect(screen.getByTestId('sync-now')).toBeTruthy();
  });

  it('withholds "Sync now" from a role that may only read the sync status', () => {
    signInWith(['sync:read']);
    render(<SyncScreen />);
    expect(screen.queryByTestId('sync-now')).toBeNull();
    // The status half stays: it reports where this device syncs, and reporting is `sync:read`.
    expect(screen.getByTestId('sync-provider-label')).toBeTruthy();
  });

  it('restores "Sync now" once the role holds `sync:write`', () => {
    signInWith(['sync:read', 'sync:write']);
    render(<SyncScreen />);
    expect(screen.getByTestId('sync-now')).toBeTruthy();
  });

  it('offers the remote-reset republish to a role holding `sync:write`', async () => {
    mockRunSync.mockRejectedValue(new SyncRemoteMissingError('the shared copy is missing'));
    signInWith(['sync:read', 'sync:write']);
    render(<SyncScreen />);

    await userEvent.click(screen.getByTestId('sync-now'));

    expect(await screen.findByTestId('republish-snapshot')).toBeTruthy();
  });

  it('takes the remote-reset republish away when the authority narrows beneath it', async () => {
    // The banner's one action overwrites the shared copy with this device's data, so it goes with
    // the key that raised it — a role change arriving on a later sync must not leave it clickable.
    mockRunSync.mockRejectedValue(new SyncRemoteMissingError('the shared copy is missing'));
    signInWith(['sync:read', 'sync:write']);
    render(<SyncScreen />);
    await userEvent.click(screen.getByTestId('sync-now'));
    await screen.findByTestId('republish-snapshot');

    act(() => signInWith(['sync:read']));

    expect(screen.queryByTestId('republish-snapshot')).toBeNull();
    expect(screen.queryByTestId('sync-remote-missing')).toBeNull();
  });
});

describe('SyncScreen — the bridge credentials are `bridge:write` (issue #429)', () => {
  it('offers the token field and "Push now" in single-user mode', () => {
    render(<SyncScreen />);
    expect(screen.getByTestId('bridge-token')).toBeTruthy();
    expect(screen.getByTestId('bridge-url')).toBeTruthy();
    expect(screen.getByTestId('push-to-bridge')).toBeTruthy();
  });

  it('withholds the URL, token and "Push now" from a `bridge:read` role', () => {
    signInWith(['bridge:read']);
    render(<SyncScreen />);
    expect(screen.queryByTestId('bridge-token')).toBeNull();
    expect(screen.queryByTestId('bridge-url')).toBeNull();
    expect(screen.queryByTestId('push-to-bridge')).toBeNull();
    // What is left still reads sensibly: the section says what a bridge is for.
    expect(screen.getByRole('heading', { name: /push to bridge/i })).toBeTruthy();
  });

  it('restores them once the role holds `bridge:write`', () => {
    signInWith(['bridge:read', 'bridge:write']);
    render(<SyncScreen />);
    expect(screen.getByTestId('bridge-token')).toBeTruthy();
    expect(screen.getByTestId('push-to-bridge')).toBeTruthy();
  });
});

describe('SyncScreen — Backup & restore does not answer to the sync keys (issue #429)', () => {
  it('keeps the entry point for a backups-only role, which holds no `sync:*` key at all', () => {
    // Backup & restore deliberately lives on this screen, so a role granted backups but not cloud
    // sync would otherwise be locked out of its own backups.
    signInWith(['backup:read']);
    render(<SyncScreen />);
    expect(screen.getByTestId('open-backup')).toBeTruthy();
    expect(screen.queryByTestId('sync-now')).toBeNull();
  });

  it('withholds it from a sync-only role, for which both actions behind it would refuse', () => {
    signInWith(['sync:read', 'sync:write']);
    render(<SyncScreen />);
    expect(screen.queryByTestId('open-backup')).toBeNull();
  });
});
