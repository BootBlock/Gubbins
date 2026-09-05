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
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('./hooks', () => ({
  useStorageBreakdown: () => ({
    isPending: false,
    data: {
      bytes: { photos: 300, itemHistory: 200, items: 100, total: 600 },
      imagesMeasured: true,
    },
  }),
  // The dialog now reads the query's *state*, not just its data, so the stubs carry the shape a
  // settled TanStack query really has (issue #898) — a bare `{ data }` would leave both rows
  // stuck on their pending branch and hide the buttons this file is about.
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
