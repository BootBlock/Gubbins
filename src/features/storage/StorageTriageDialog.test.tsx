/**
 * StorageTriageDialog permission gating (issue #429).
 *
 * Both reclaim workflows delete data from this device, so they answer to `storage:write`.
 * A session without it still gets the breakdown — that is what the storage banner sent it
 * here for — but is offered no door the gate would refuse.
 *
 * The storage hooks are the async IO boundary, mocked at the module level so no DB or OPFS
 * is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('./hooks', () => ({
  useStorageBreakdown: () => ({
    isPending: false,
    data: {
      bytes: { photos: 300, itemHistory: 200, items: 100, total: 600 },
      imagesMeasured: true,
    },
  }),
  // A settled query's real shape, because the dialog gates each workflow on `isSuccess` rather
  // than on `data` alone (issue #898): a bare `{ data: 5 }` stub would render both buttons
  // *disabled*, which this file's presence-only assertions would not have caught.
  usePruneCandidateCount: () => ({ data: 5, isPending: false, isError: false, isSuccess: true }),
  useDowngradeCandidateCount: () => ({ data: 3, isPending: false, isError: false, isSuccess: true }),
  useArchiveAndPruneHistory: () => ({ isPending: false, mutate: vi.fn() }),
  useDowngradeImages: () => ({ isPending: false, mutate: vi.fn() }),
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
  render(
    <ToastProvider>
      <StorageTriageDialog open onClose={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

describe('StorageTriageDialog — storage:write gating', () => {
  it('offers both reclaim workflows to an unrestricted session', () => {
    renderDialog();
    expect(screen.queryByTestId('prune-history')).not.toBeNull();
    expect(screen.queryByTestId('downgrade-images')).not.toBeNull();
  });

  it('hides both workflows — headings and windows included — without storage:write', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['storage:read']) } });
    renderDialog();
    expect(screen.queryByTestId('prune-history')).toBeNull();
    expect(screen.queryByTestId('downgrade-images')).toBeNull();
    // The whole section goes, not just its button: no orphaned window picker or count.
    expect(screen.queryByTestId('prune-months')).toBeNull();
    expect(screen.queryByTestId('downgrade-months')).toBeNull();
    expect(screen.queryByRole('heading', { name: /purge old activity history/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /downgrade old images/i })).toBeNull();
  });

  it('still shows the storage breakdown, which is what the banner sent them for', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['storage:read']) } });
    renderDialog();
    expect(screen.queryByTestId('triage-row-images')).not.toBeNull();
    expect(screen.queryByTestId('triage-row-history')).not.toBeNull();
  });
});

/**
 * What the downgrade workflow promises about recovery (issue #824).
 *
 * It deletes the only local copy of every full-resolution photo and archives nothing first, yet
 * it used to offer the cloud backup as the safety net — and the sync artefact has never carried
 * image bytes, so that was a reassurance about a copy that does not exist. These assertions fail
 * if any such promise comes back, and if the pointer to the one artefact that *does* hold those
 * photos (a backup) goes missing from in front of the confirm.
 */
describe('StorageTriageDialog — the downgrade keeps no copy, and says so (issue #824)', () => {
  it('warns that nothing is archived first, and points at a backup', () => {
    renderDialog();
    const warning = screen.getByTestId('downgrade-no-copy');
    expect(warning.textContent).toMatch(/nothing is archived first/i);
    expect(warning.textContent).toMatch(/backup/i);
  });

  it('offers no recovery the app cannot actually make', () => {
    renderDialog();
    // Scoped to this workflow's own section rather than the whole document: "cloud sync is
    // unaffected" is a true and reasonable thing to say elsewhere in the app (the erase dialog
    // already does), and it is only beside *this* delete, offered as the reassurance, that it
    // becomes the false promise. Broad within that scope, though: any wording leaving cloud sync
    // sounding like a way back is the same claim, whatever words carry it.
    const section = screen.getByRole('region', { name: /downgrade old images/i });
    expect(section.textContent).not.toMatch(/cloud (backup|sync)[^.]*(untouched|unaffected)/i);
  });

  it('says the deletion cannot be undone in the confirmation itself', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('downgrade-images'));
    const confirm = screen.getByRole('alertdialog', { name: 'Confirm' });
    expect(confirm.textContent).toMatch(/cannot be undone/i);
  });
});
