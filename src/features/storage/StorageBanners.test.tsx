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

import { ToastProvider } from '@/components/foundry';
import { StorageBanners } from './StorageBanners';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { useAuthStore } from '@/state/stores/useAuthStore';

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
  requestPersistentStorage.mockReset();
});
afterEach(cleanup);

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
