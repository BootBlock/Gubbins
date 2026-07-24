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

// AppNav reads the live route via `useRouterState` (not provided by the plain-anchor Link
// mock above) and alerts via a hook — out of scope for this grid-focused test, so stub it.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <div data-testid="app-nav" />,
}));

// The widget board and wake-lock are out of scope here; stub them so the test
// stays focused on the quick-nav grid driven by NAV_DESTINATIONS.
vi.mock('./DashboardGrid', () => ({ DashboardGrid: () => <div data-testid="dashboard-grid" /> }));
vi.mock('./useWakeLock', () => ({ useWakeLock: () => {} }));
// Reads the item count via TanStack Query (no provider in this focused test) — stub it.
vi.mock('./DashboardGettingStarted', () => ({ DashboardGettingStarted: () => null }));
// Likewise reads item count + auth via hooks that need providers; stub for this focused test.
vi.mock('./DashboardBackupNudge', () => ({ DashboardBackupNudge: () => null }));

// DashboardNav's collection-count pills reach TanStack Query via useNavCounts (no provider in
// this grid-focused test) — stub it to an empty map so no tile shows a count.
vi.mock('./useNavCounts', () => ({ useNavCounts: () => ({}) }));

const alertsMock = vi.fn();
vi.mock('@/features/alerts/useAlerts', () => ({ useAlerts: () => alertsMock() }));

import { DashboardScreen } from './DashboardScreen';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';
import { getFeature } from '@/features/modules/feature-registry';

beforeEach(() => {
  alertsMock.mockReturnValue({ alerts: [], allAlerts: [], isLoading: false, isError: false });
});
afterEach(cleanup);

describe('DashboardScreen — quick-nav grid (spec §2.4.2)', () => {
  it('maps every destination except the dashboard itself into a nav tile', () => {
    render(<DashboardScreen />);
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    // One tile per destination, minus the current (Dashboard/home) screen. Most tiles are
    // links; Settings is a button (it opens the Settings dialog rather than navigating), so
    // count both roles.
    const tiles = [...within(nav).getAllByRole('link'), ...within(nav).getAllByRole('button')];
    // An opt-in feature (`FeatureDef.defaultOff`, e.g. Users) is off under the default intent, so
    // it has no tile until it is switched on — derived from the registry, not hard-coded.
    const defaultOn = NAV_DESTINATIONS.filter((d) => !getFeature(d.feature)?.defaultOff);
    expect(tiles).toHaveLength(defaultOn.length - 1);
    expect(within(nav).queryByText('Dashboard')).toBeNull();
  });

  it('renders the global navigation menu on the hero toolbar (parity with every other screen)', () => {
    render(<DashboardScreen />);
    // The dashboard hero is a PageHeader exception, so it mounts AppNav itself — the same
    // menu button PageHeader gives every other screen, here pinned to the right of the
    // Search/Add/Scan toolbar row. Guards against regressing back to a menu-less landing page.
    expect(screen.getByTestId('app-nav')).toBeInTheDocument();
  });

  it('renders Inventory as the primary call-to-action', () => {
    render(<DashboardScreen />);
    const cta = screen.getByRole('link', { name: 'Inventory' });
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
