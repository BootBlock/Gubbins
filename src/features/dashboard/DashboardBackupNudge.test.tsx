import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const itemCountMock = vi.fn();
vi.mock('@/features/inventory/queries', () => ({ useItemCount: () => itemCountMock() }));

import { DashboardBackupNudge } from './DashboardBackupNudge';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useAuthStore } from '@/state/stores/useAuthStore';

beforeEach(() => {
  usePreferencesStore.setState({ backupNudgeDismissed: false });
  useAuthStore.setState({ providerId: null });
  // Default: a non-empty inventory (something worth protecting).
  itemCountMock.mockReturnValue({ data: 5, isPending: false });
});
afterEach(cleanup);

describe('DashboardBackupNudge', () => {
  it('shows when there is data and no sync provider is connected', () => {
    render(<DashboardBackupNudge />);
    expect(screen.getByTestId('dashboard-backup-nudge')).toBeTruthy();
    expect(screen.getByTestId('backup-nudge-open').getAttribute('href')).toBe('/sync');
  });

  it('hides on an empty inventory (nothing to protect yet)', () => {
    itemCountMock.mockReturnValue({ data: 0, isPending: false });
    render(<DashboardBackupNudge />);
    expect(screen.queryByTestId('dashboard-backup-nudge')).toBeNull();
  });

  it('hides while the count is still loading (no flash)', () => {
    itemCountMock.mockReturnValue({ data: undefined, isPending: true });
    render(<DashboardBackupNudge />);
    expect(screen.queryByTestId('dashboard-backup-nudge')).toBeNull();
  });

  it('hides once a sync provider is connected', () => {
    useAuthStore.setState({ providerId: 'google-drive' });
    render(<DashboardBackupNudge />);
    expect(screen.queryByTestId('dashboard-backup-nudge')).toBeNull();
  });

  it('hides when previously dismissed', () => {
    usePreferencesStore.setState({ backupNudgeDismissed: true });
    render(<DashboardBackupNudge />);
    expect(screen.queryByTestId('dashboard-backup-nudge')).toBeNull();
  });

  it('dismissing hides it and persists the choice', () => {
    render(<DashboardBackupNudge />);
    fireEvent.click(screen.getByTestId('backup-nudge-dismiss'));
    expect(usePreferencesStore.getState().backupNudgeDismissed).toBe(true);
    expect(screen.queryByTestId('dashboard-backup-nudge')).toBeNull();
  });
});
