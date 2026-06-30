import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

// Plain-anchor Link so the screen renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// The widget board and wake-lock are out of scope here; stub them so the test
// stays focused on the quick-nav grid driven by NAV_DESTINATIONS.
vi.mock('./DashboardGrid', () => ({ DashboardGrid: () => <div data-testid="dashboard-grid" /> }));
vi.mock('./useWakeLock', () => ({ useWakeLock: () => {} }));
// Reads the item count via TanStack Query (no provider in this focused test) — stub it.
vi.mock('./DashboardGettingStarted', () => ({ DashboardGettingStarted: () => null }));

const alertsMock = vi.fn();
vi.mock('@/features/alerts/useAlerts', () => ({ useAlerts: () => alertsMock() }));

import { DashboardScreen } from './DashboardScreen';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';

beforeEach(() => {
  alertsMock.mockReturnValue({ alerts: [], allAlerts: [], isLoading: false, isError: false });
});
afterEach(cleanup);

describe('DashboardScreen — quick-nav grid (spec §2.4.2)', () => {
  it('maps every destination except the dashboard itself into a nav tile', () => {
    render(<DashboardScreen />);
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const links = within(nav).getAllByRole('link');
    // One tile per destination, minus the current (Dashboard/home) screen.
    expect(links).toHaveLength(NAV_DESTINATIONS.length - 1);
    expect(within(nav).queryByText('Dashboard')).toBeNull();
  });

  it('renders Inventory as the primary call-to-action ("Open inventory")', () => {
    render(<DashboardScreen />);
    const cta = screen.getByRole('link', { name: /Open inventory/ });
    expect(cta.getAttribute('href')).toBe('/inventory');
  });

  it('shows the alert badge and count-laden label on the Alerts tile when alerts are active', () => {
    alertsMock.mockReturnValue({
      alerts: [{ id: 'a' }, { id: 'b' }],
      allAlerts: [],
      isLoading: false,
      isError: false,
    });
    render(<DashboardScreen />);
    expect(screen.getByTestId('alerts-badge').textContent).toBe('2');
    expect(screen.getByTestId('nav-alerts').getAttribute('aria-label')).toContain('2 active alert');
  });

  it('omits the alert badge when there are no alerts', () => {
    render(<DashboardScreen />);
    expect(screen.queryByTestId('alerts-badge')).toBeNull();
  });
});
