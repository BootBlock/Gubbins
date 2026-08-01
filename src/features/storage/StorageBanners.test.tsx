import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Control the outcome of the browser persistence request. The store calls this
// module's `requestPersistentStorage`, so mocking it lets us drive both branches.
const requestPersistentStorage = vi.fn();
vi.mock('@/features/storage/storage-api', () => ({
  requestPersistentStorage: () => requestPersistentStorage(),
  estimateStorage: () => Promise.resolve({ usage: 0, quota: 0, ratio: 0, supported: false }),
  isStoragePersisted: () => Promise.resolve(false),
}));

// Drive the mobile/desktop split (the weekly-backup nudge is mobile-only). Defaults to
// desktop so the persistence-feedback tests behave as before; the archive tests flip it.
const isLikelyMobile = vi.fn(() => false);
vi.mock('@/lib/env/feature-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/env/feature-detection')>()),
  isLikelyMobile: () => isLikelyMobile(),
}));

// Drive the archive outcome so both the success and failure paths can be asserted.
const runFullArchive = vi.fn();
vi.mock('@/features/archive/auto-archive', async (importActual) => ({
  ...(await importActual<typeof import('@/features/archive/auto-archive')>()),
  runFullArchive: () => runFullArchive(),
}));

import { ToastProvider } from '@/components/foundry';
import { StorageBanners } from './StorageBanners';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLabStore } from '@/state/stores/useLabStore';
import { ARCHIVE_NUDGE_SNOOZE_MS } from '@/features/archive/auto-archive';

function renderBanners() {
  return render(
    <ToastProvider>
      <StorageBanners />
    </ToastProvider>,
  );
}

beforeEach(() => {
  useStorageStore.setState({
    persisted: false,
    tier: 'ok',
    measuredTier: 'ok',
    exhaustion: null,
    warningDismissed: false,
    estimate: null,
    ratio: 0,
  });
  useAuthStore.setState({ providerId: null });
  usePreferencesStore.setState({ lastArchivedAt: null, archiveNudgeSnoozedUntil: null });
  requestPersistentStorage.mockReset();
  runFullArchive.mockReset();
  isLikelyMobile.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  useLabStore.getState().resetLab();
});

describe('StorageBanners — persistence request feedback', () => {
  it('shows the ephemeral-data banner while storage is not persisted', () => {
    renderBanners();
    expect(screen.getByText('Your data may be cleared by the browser')).toBeTruthy();
  });

  it('reports success and hides the banner when the browser grants persistence', async () => {
    requestPersistentStorage.mockResolvedValue(true);
    renderBanners();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => expect(screen.getByText('Storage set to persistent')).toBeTruthy());
    // Granting flips the store flag, so the banner is gone.
    expect(screen.queryByText('Your data may be cleared by the browser')).toBeNull();
  });

  it('explains what happened (no silent no-op) when the browser declines', async () => {
    requestPersistentStorage.mockResolvedValue(false);
    renderBanners();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => expect(screen.getByText('Browser kept storage temporary')).toBeTruthy());
    // The banner stays because persistence is still off, but the user now has feedback.
    expect(screen.getByText('Your data may be cleared by the browser')).toBeTruthy();
  });
});

describe('StorageBanners — `storage-persistence-denied` lab flag', () => {
  it('hides the ephemeral-data banner once the browser has genuinely granted persistence', () => {
    useStorageStore.setState({ persisted: true });
    renderBanners();
    expect(screen.queryByText('Your data may be cleared by the browser')).toBeNull();
  });

  it('shows the ephemeral-data banner while the flag is on, even though persistence was granted', () => {
    useStorageStore.setState({ persisted: true });
    useLabStore.getState().setFlag('storage-persistence-denied', true);
    renderBanners();
    expect(screen.getByText('Your data may be cleared by the browser')).toBeTruthy();
  });
});

/**
 * Issue #504: the Hard Stop can now be reached by a write that actually ran out of space, not only
 * by the estimate crossing 95%. Quoting the estimate then would read as nonsense ("saving paused…
 * 12% used"), so that case explains the disagreement instead.
 */
describe('StorageBanners — the Hard Stop', () => {
  it('quotes the measured usage when the measurement is what tripped it', () => {
    useStorageStore.setState({
      tier: 'locked',
      measuredTier: 'locked',
      ratio: 0.97,
      estimate: { usage: 97, quota: 100, ratio: 0.97, supported: true },
    });
    renderBanners();
    expect(screen.getByText(/Gubbins has paused all writes to protect your data/)).toBeTruthy();
    expect(screen.getByTestId('open-storage-triage')).toBeTruthy();
  });

  it('explains the disagreement when a failed write is what tripped it', () => {
    // The estimate still shows ample headroom — a padded quota, an opaque VFS pool, or a device
    // the Storage API cannot see is full. The banner must not present that figure as the reason.
    useStorageStore.setState({
      tier: 'locked',
      measuredTier: 'ok',
      ratio: 0.12,
      estimate: { usage: 12, quota: 100, ratio: 0.12, supported: true },
      exhaustion: { afterMeasurement: 1, measured: true, baselineAvailable: 88 },
    });
    renderBanners();

    expect(screen.getByText('Storage full — saving paused')).toBeTruthy();
    expect(screen.getByText(/A save failed because this device has no room left/)).toBeTruthy();
    expect(screen.getByText(/still reports only 12% used/)).toBeTruthy();
    // The route out is still offered, exactly as it is from the measured Hard Stop.
    expect(screen.getByTestId('open-storage-triage')).toBeTruthy();
    expect(screen.queryByText(/Gubbins has paused all writes to protect your data/)).toBeNull();
  });

  it('does not invent a percentage when the browser reports no quota at all', () => {
    // `estimateStorage` returns `ratio: 0` as its "no reading" sentinel, so quoting it would
    // assert a figure the browser never gave — the same state Triage describes as "does not
    // report a storage quota".
    useStorageStore.setState({
      tier: 'locked',
      measuredTier: 'ok',
      ratio: 0,
      estimate: { usage: 0, quota: 0, ratio: 0, supported: false },
      exhaustion: { afterMeasurement: 1, measured: true, baselineAvailable: null },
    });
    renderBanners();

    expect(screen.getByText('Storage full — saving paused')).toBeTruthy();
    expect(screen.getByText(/does not report how much storage is in use/)).toBeTruthy();
    expect(screen.queryByText(/reports only 0% used/)).toBeNull();
  });
});

describe('StorageBanners — weekly-backup nudge dismissal', () => {
  beforeEach(() => {
    // Mobile, no sync provider, never archived → the weekly-backup nudge is due.
    isLikelyMobile.mockReturnValue(true);
    useAuthStore.setState({ providerId: null });
    usePreferencesStore.setState({ lastArchivedAt: null, archiveNudgeSnoozedUntil: null });
  });

  it('shows the weekly-backup nudge when a mobile user without sync is due', () => {
    renderBanners();
    expect(screen.getByText('Time for a weekly backup')).toBeTruthy();
  });

  it('dismissing snoozes the nudge for a week and hides it', () => {
    const before = Date.now();
    renderBanners();

    fireEvent.click(screen.getByTestId('archive-nudge-dismiss'));

    // Banner is gone…
    expect(screen.queryByText('Time for a weekly backup')).toBeNull();
    // …and the snooze was stamped roughly a week out (persisted, so it survives a reload).
    const snoozedUntil = usePreferencesStore.getState().archiveNudgeSnoozedUntil;
    expect(snoozedUntil).not.toBeNull();
    expect(snoozedUntil!).toBeGreaterThanOrEqual(before + ARCHIVE_NUDGE_SNOOZE_MS);
  });

  it('stays hidden while the snooze window is still open', () => {
    usePreferencesStore.setState({ archiveNudgeSnoozedUntil: Date.now() + ARCHIVE_NUDGE_SNOOZE_MS });
    renderBanners();
    expect(screen.queryByText('Time for a weekly backup')).toBeNull();
  });

  it('returns once the snooze window has elapsed', () => {
    usePreferencesStore.setState({ archiveNudgeSnoozedUntil: Date.now() - 1000 });
    renderBanners();
    expect(screen.getByText('Time for a weekly backup')).toBeTruthy();
  });
});

describe('StorageBanners — archive outcome feedback', () => {
  beforeEach(() => {
    // Mobile, no sync provider, never archived → the weekly-backup nudge (and its button) is due.
    isLikelyMobile.mockReturnValue(true);
  });

  it('confirms the download and stamps the archive time on success', async () => {
    runFullArchive.mockResolvedValue('gubbins-archive-20260718-1200.zip');
    renderBanners();

    fireEvent.click(screen.getByTestId('run-archive'));

    await waitFor(() => expect(screen.getByText('Archive downloaded')).toBeTruthy());
    expect(screen.getByText(/gubbins-archive-20260718-1200\.zip/)).toBeTruthy();
    expect(usePreferencesStore.getState().lastArchivedAt).not.toBeNull();
  });

  it('says so — rather than falling quiet — when the archive fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    runFullArchive.mockRejectedValue(new Error('quota exceeded'));
    renderBanners();

    fireEvent.click(screen.getByTestId('run-archive'));

    await waitFor(() => expect(screen.getByText('Archive failed')).toBeTruthy());
    // The "last archived" stamp must not advance — the nudge is still due, and the banner stays.
    expect(usePreferencesStore.getState().lastArchivedAt).toBeNull();
    expect(screen.getByText('Time for a weekly backup')).toBeTruthy();
    // The button is usable again so the offered retry can actually run.
    expect(screen.getByTestId('run-archive').hasAttribute('disabled')).toBe(false);
    consoleError.mockRestore();
  });

  it('offers a retry that re-runs the archive', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    runFullArchive.mockRejectedValueOnce(new Error('transient')).mockResolvedValue('retry.zip');
    renderBanners();

    fireEvent.click(screen.getByTestId('run-archive'));
    await waitFor(() => expect(screen.getByText('Archive failed')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByText('Archive downloaded')).toBeTruthy());
    expect(runFullArchive).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
