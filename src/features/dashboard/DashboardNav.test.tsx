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

// The count pills are fed by useNavCounts, which reaches TanStack Query / the repositories;
// stub it so this suite stays a pure render test (the real selectors + nouns are covered in
// useNavCounts.test.ts). Each entry carries the spoken nouns for the tile's current metric.
const navCountsMock = vi.fn();
vi.mock('./useNavCounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useNavCounts')>()),
  useNavCounts: () => navCountsMock(),
}));

import { DashboardNav } from './DashboardNav';
import { useModulesStore } from '@/state/stores/useModulesStore';

beforeEach(() => {
  alertsMock.mockReturnValue({ alerts: [], allAlerts: [], isLoading: false, isError: false });
  navCountsMock.mockReturnValue({});
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

describe('DashboardNav — collection count pills', () => {
  it('shows a right-aligned count pill on a counted tile and names it for screen readers', () => {
    navCountsMock.mockReturnValue({
      '/projects': { count: 3, noun: 'active project', nounPlural: 'active projects' },
      '/inventory': { count: 42, noun: 'item', nounPlural: 'items' },
    });
    render(<DashboardNav />);

    expect(screen.getByTestId('nav-count-/projects')).toHaveTextContent('3');
    expect(screen.getByTestId('nav-count-/inventory')).toHaveTextContent('42');
    // The spoken name disambiguates the bare number.
    expect(tile('/projects')).toHaveAttribute('aria-label', 'Projects — 3 active projects');
    expect(tile('/inventory')).toHaveAttribute('aria-label', 'Open inventory — 42 items');
  });

  it('names a tile with the plural for its current (re-pointed) metric', () => {
    // The tile has been re-pointed at "all projects", so the noun follows the chosen metric.
    navCountsMock.mockReturnValue({
      '/projects': { count: 5, noun: 'project', nounPlural: 'projects' },
    });
    render(<DashboardNav />);
    expect(tile('/projects')).toHaveAttribute('aria-label', 'Projects — 5 projects');
  });

  it('omits the pill for a zero or absent count', () => {
    navCountsMock.mockReturnValue({
      '/projects': { count: 0, noun: 'active project', nounPlural: 'active projects' },
    });
    render(<DashboardNav />);

    expect(screen.queryByTestId('nav-count-/projects')).toBeNull();
    // A route with no count entry at all is likewise bare.
    expect(screen.queryByTestId('nav-count-/contacts')).toBeNull();
    expect(tile('/projects')).not.toHaveAttribute('aria-label');
  });

  it('caps a very large count so it cannot stretch the tile', () => {
    navCountsMock.mockReturnValue({
      '/inventory': { count: 100000, noun: 'item', nounPlural: 'items' },
    });
    render(<DashboardNav />);

    expect(screen.getByTestId('nav-count-/inventory')).toHaveTextContent('999+');
    // The exact figure still rides on the accessible name.
    expect(tile('/inventory')).toHaveAttribute('aria-label', 'Open inventory — 100000 items');
  });
});
