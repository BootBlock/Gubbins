import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const routerState = { pathname: '/inventory' };
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: routerState.pathname } }),
}));

const alertsMock = vi.fn();
vi.mock('@/features/alerts/useAlerts', () => ({
  useAlerts: () => alertsMock(),
}));

import { AppNav } from './AppNav';
import { NAV_DESTINATIONS } from './nav-destinations';

beforeEach(() => {
  routerState.pathname = '/inventory';
  alertsMock.mockReturnValue({ alerts: [], allAlerts: [], isLoading: false, isError: false });
});
afterEach(cleanup);

function openNav() {
  fireEvent.click(screen.getByTestId('app-nav'));
}

describe('AppNav — global navigation menu (spec §2.4.2)', () => {
  it('lists every registered destination, so any screen reaches any other', () => {
    render(<AppNav />);
    openNav();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(NAV_DESTINATIONS.length);
    // The previously-unreachable screens are present from anywhere.
    for (const label of ['About', 'Settings', 'Dashboard', 'Activity']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it('marks the current route with aria-current="page"', () => {
    routerState.pathname = '/reports';
    render(<AppNav />);
    openNav();
    expect(screen.getByRole('menuitem', { name: /Reports/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('menuitem', { name: /Inventory/ }).getAttribute('aria-current')).toBeNull();
  });

  it('shows an alert badge on the trigger and the Alerts row when alerts are active', () => {
    alertsMock.mockReturnValue({
      alerts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      allAlerts: [],
      isLoading: false,
      isError: false,
    });
    render(<AppNav />);
    expect(screen.getByTestId('app-nav-alert-badge').textContent).toBe('3');
    openNav();
    expect(screen.getByTestId('app-nav-alerts-count').textContent).toBe('3');
  });

  it('hides the badge entirely when there are no alerts', () => {
    render(<AppNav />);
    expect(screen.queryByTestId('app-nav-alert-badge')).toBeNull();
  });

  it('caps the badge at 99+', () => {
    alertsMock.mockReturnValue({
      alerts: Array.from({ length: 150 }, (_, i) => ({ id: String(i) })),
      allAlerts: [],
      isLoading: false,
      isError: false,
    });
    render(<AppNav />);
    expect(screen.getByTestId('app-nav-alert-badge').textContent).toBe('99+');
  });
});
