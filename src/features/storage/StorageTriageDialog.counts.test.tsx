/**
 * Storage Triage candidate counts — what each row shows when its figure is not yet a fact
 * (issue #898).
 *
 * The two "N affected" rows used to render `data ?? 0`, so a count still in flight and a count
 * whose query had failed both read out as a confident "0 entries affected" beside a greyed-out
 * button — permanently, with no error and no retry. These tests drive the *real* hooks through a
 * real query client, stubbing only the repository boundary, so a regression has to survive the
 * same wiring the dialog actually ships with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rowCounts = vi.hoisted(() => vi.fn());
const countHistoryBefore = vi.hoisted(() => vi.fn());
const countDowngradableBefore = vi.hoisted(() => vi.fn());

vi.mock('@/db/repositories', () => ({
  getStorageRepository: () => ({ rowCounts, countHistoryBefore, countDowngradableBefore }),
}));

vi.mock('@/features/images/opfs-images', () => ({
  imagesBytesOnDisk: () => Promise.resolve(1_000),
  deleteImageFile: vi.fn(),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    bytes: (n: number) => `${n} B`,
    percent: (ratio: number) => `${Math.round(ratio * 100)}%`,
    quantity: (n: number) => String(n),
  }),
}));

import { ToastProvider } from '@/components/foundry';
import { StorageTriageDialog } from './StorageTriageDialog';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <StorageTriageDialog open onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rowCounts.mockReset().mockResolvedValue({ items: 10, itemHistory: 20, photos: 5 });
  countHistoryBefore.mockReset();
  countDowngradableBefore.mockReset().mockResolvedValue(3);
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

describe('StorageTriageDialog — a candidate count that is not a fact yet', () => {
  it('shows the count is being worked out rather than claiming zero, before any query settles', () => {
    countHistoryBefore.mockReturnValue(new Promise(() => {}));
    countDowngradableBefore.mockReturnValue(new Promise(() => {}));
    renderDialog();

    expect(screen.queryByTestId('prune-count-pending')).not.toBeNull();
    expect(screen.queryByTestId('downgrade-count-pending')).not.toBeNull();
    expect(screen.queryByTestId('prune-count')).toBeNull();
    expect(screen.queryByTestId('downgrade-count')).toBeNull();
    expect(document.body.textContent).not.toContain('0 entries affected');
    expect(document.body.textContent).not.toContain('0 images affected');
  });

  it('says the history count failed, offers a retry, and leaves the healthy sibling live', async () => {
    countHistoryBefore.mockRejectedValue(new Error('database is locked'));
    renderDialog();

    const error = await screen.findByTestId('prune-count-error');
    // The failure is announced, not merely printed — the dialog is already open, so nothing
    // else would tell a screen-reader user that half of it stopped working.
    expect(error.getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('prune-count')).toBeNull();
    expect(document.body.textContent).not.toContain('0 entries affected');
    expect(screen.queryByTestId('prune-count-retry')).not.toBeNull();
    expect(screen.getByTestId('prune-history').hasAttribute('disabled')).toBe(true);

    // The downgrade half counted fine, so it must still offer its workflow: a dialog where
    // everything is dead cannot be told apart from a device with nothing to reclaim.
    expect(await screen.findByTestId('downgrade-count')).not.toBeNull();
    expect(screen.getByTestId('downgrade-images').hasAttribute('disabled')).toBe(false);
  });

  it('recovers the real figure when the retry succeeds', async () => {
    countHistoryBefore.mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(7);
    renderDialog();

    fireEvent.click(await screen.findByTestId('prune-count-retry'));

    await waitFor(() => expect(screen.queryByTestId('prune-count-error')).toBeNull());
    expect(screen.getByTestId('prune-count').textContent).toContain('7 entries affected');
    expect(screen.getByTestId('prune-history').hasAttribute('disabled')).toBe(false);
  });

  it('still disables the workflow when the count genuinely is zero', async () => {
    countHistoryBefore.mockResolvedValue(0);
    renderDialog();

    expect((await screen.findByTestId('prune-count')).textContent).toContain('0 entries affected');
    expect(screen.queryByTestId('prune-count-error')).toBeNull();
    expect(screen.getByTestId('prune-history').hasAttribute('disabled')).toBe(true);
  });
});
