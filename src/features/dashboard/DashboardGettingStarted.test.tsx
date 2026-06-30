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

import { DashboardGettingStarted } from './DashboardGettingStarted';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';

beforeEach(() => {
  usePreferencesStore.setState({ dashboardGettingStarted: true });
  useInventoryEntry.setState({ pendingSearch: null, pendingIntent: null });
  itemCountMock.mockReturnValue({ data: 0, isPending: false });
});
afterEach(cleanup);

describe('DashboardGettingStarted', () => {
  it('shows the panel when the inventory is empty', () => {
    render(<DashboardGettingStarted />);
    expect(screen.getByTestId('dashboard-getting-started')).toBeTruthy();
    expect(screen.getByTestId('getting-started-add')).toBeTruthy();
    expect(screen.getByTestId('getting-started-import')).toBeTruthy();
    expect(screen.getByTestId('getting-started-scan')).toBeTruthy();
  });

  it('hides once any item exists', () => {
    itemCountMock.mockReturnValue({ data: 3, isPending: false });
    render(<DashboardGettingStarted />);
    expect(screen.queryByTestId('dashboard-getting-started')).toBeNull();
  });

  it('hides while the count is still loading (no flash)', () => {
    itemCountMock.mockReturnValue({ data: undefined, isPending: true });
    render(<DashboardGettingStarted />);
    expect(screen.queryByTestId('dashboard-getting-started')).toBeNull();
  });

  it('hides when the preference is off', () => {
    usePreferencesStore.setState({ dashboardGettingStarted: false });
    render(<DashboardGettingStarted />);
    expect(screen.queryByTestId('dashboard-getting-started')).toBeNull();
  });

  it('records the matching intent when an action is clicked', () => {
    render(<DashboardGettingStarted />);
    fireEvent.click(screen.getByTestId('getting-started-import'));
    expect(useInventoryEntry.getState().pendingIntent).toBe('import');
  });
});
