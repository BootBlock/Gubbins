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
    warningDismissed: false,
    estimate: null,
    ratio: 0,
  });
  useAuthStore.setState({ providerId: null });
  usePreferencesStore.setState({ lastArchivedAt: null, archiveNudgeSnoozedUntil: null });
  requestPersistentStorage.mockReset();
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
