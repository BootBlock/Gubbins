import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Router: DashboardNav only needs Link, rendered as a plain anchor for querying.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const alertsMock = vi.fn();
vi.mock('@/features/alerts/useAlerts', () => ({
  useAlerts: () => alertsMock(),
}));

import { DashboardNav } from './DashboardNav';
import { useModulesStore } from '@/state/stores/useModulesStore';

beforeEach(() => {
  alertsMock.mockReturnValue({ alerts: [], allAlerts: [], isLoading: false, isError: false });
  useModulesStore.setState({ intent: {} });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
});

/** The tile for a route, found via its anchor `href` (labels differ, e.g. "Open inventory"). */
function tile(to: string): HTMLElement | null {
  return document.querySelector(`a[href="${to}"]`);
}

describe('DashboardNav — feature gating (Phase 2)', () => {
  it('shows every optional tile with the default everything-on intent', () => {
    render(<DashboardNav />);
    for (const to of ['/inventory', '/projects', '/purchase-orders', '/contacts', '/bookings', '/sync']) {
      expect(tile(to), to).not.toBeNull();
    }
    // The dashboard itself is the current screen and never appears as a tile.
    expect(tile('/')).toBeNull();
  });

  it('drops a tile whose feature is switched off, keeping the core Inventory tile', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardNav />);
    expect(tile('/projects')).toBeNull();
    expect(tile('/inventory')).not.toBeNull();
    // Settings is a dialog, not a screen: its tile is a button that opens the dialog, so it
    // has no `/settings` anchor — it is always present (core, never feature-gated).
    expect(screen.getByTestId('nav-settings')).toBeTruthy();
  });

  it('cascades: turning contacts off hides its dependents (purchase orders, bookings)', () => {
    useModulesStore.getState().setFeatureIntent('contacts', false);
    render(<DashboardNav />);
    expect(tile('/contacts')).toBeNull();
    expect(tile('/purchase-orders')).toBeNull();
    expect(tile('/bookings')).toBeNull();
  });

  it('collapses an emptied group so its heading disappears', () => {
    // Switching every `manage` member off must remove the whole section (returns null).
    for (const id of ['contacts', 'bookings', 'upcoming', 'activity', 'alerts'] as const) {
      useModulesStore.getState().setFeatureIntent(id, false);
    }
    render(<DashboardNav />);
    expect(screen.queryByRole('region', { name: 'Manage' })).toBeNull();
    // The other groups' headings survive.
    expect(screen.getByRole('region', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'System' })).toBeTruthy();
  });
});
