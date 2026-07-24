import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useDashboardCustomise } from './useDashboardCustomise';

beforeEach(() => {
  alertsMock.mockReturnValue({ alerts: [], allAlerts: [], isLoading: false, isError: false });
  navCountsMock.mockReturnValue({});
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ navTileOrder: [] });
  // The Customise toggle is now the shared hub edit mode — reset it so each test starts in view.
  useDashboardCustomise.setState({ editing: false });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ navTileOrder: [] });
  useDashboardCustomise.setState({ editing: false });
});

/** Ids of the persisted nav order restricted to one group (empty until the user customises). */
function persistedGroup(group: string): string[] {
  return useLayoutStore
    .getState()
    .navTileOrder.filter((p) => p.group === group)
    .map((p) => p.id);
}

/** Enter the hub's Customise (edit) mode. */
function customise(): void {
  fireEvent.click(screen.getByTestId('customise-nav'));
}

/** The tile for a route, found via its anchor `href` (labels differ, e.g. "Purchasing"). */
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
      '/projects': { count: 3, noun: 'active project', nounPlural: 'active projects', tone: 'neutral' },
      '/inventory': { count: 42, noun: 'item', nounPlural: 'items', tone: 'neutral' },
    });
    render(<DashboardNav />);

    expect(screen.getByTestId('nav-count-/projects')).toHaveTextContent('3');
    expect(screen.getByTestId('nav-count-/inventory')).toHaveTextContent('42');
    // The spoken name disambiguates the bare number.
    expect(tile('/projects')).toHaveAttribute('aria-label', 'Projects — 3 active projects');
    expect(tile('/inventory')).toHaveAttribute('aria-label', 'Inventory — 42 items');
  });

  it('names a tile with the plural for its current (re-pointed) metric', () => {
    // The tile has been re-pointed at "all projects", so the noun follows the chosen metric.
    navCountsMock.mockReturnValue({
      '/projects': { count: 5, noun: 'project', nounPlural: 'projects', tone: 'neutral' },
    });
    render(<DashboardNav />);
    expect(tile('/projects')).toHaveAttribute('aria-label', 'Projects — 5 projects');
  });

  it('omits the pill for a zero or absent count', () => {
    navCountsMock.mockReturnValue({
      '/projects': { count: 0, noun: 'active project', nounPlural: 'active projects', tone: 'neutral' },
    });
    render(<DashboardNav />);

    expect(screen.queryByTestId('nav-count-/projects')).toBeNull();
    // A route with no count entry at all is likewise bare.
    expect(screen.queryByTestId('nav-count-/contacts')).toBeNull();
    expect(tile('/projects')).not.toHaveAttribute('aria-label');
  });

  it('caps a very large count so it cannot stretch the tile', () => {
    navCountsMock.mockReturnValue({
      '/inventory': { count: 100000, noun: 'item', nounPlural: 'items', tone: 'neutral' },
    });
    render(<DashboardNav />);

    expect(screen.getByTestId('nav-count-/inventory')).toHaveTextContent('999+');
    // The exact figure still rides on the accessible name.
    expect(tile('/inventory')).toHaveAttribute('aria-label', 'Inventory — 100000 items');
  });

  it('tints a "problem"-tone count with a warning/destructive token, not the group hue (A2)', () => {
    navCountsMock.mockReturnValue({
      // Inventory is the solid-primary CTA → a solid destructive fill so the alert pops.
      '/inventory': { count: 2, noun: 'out-of-stock item', nounPlural: 'out-of-stock items', tone: 'danger' },
      // A translucent group tile → the soft warning wash + warning text token.
      '/projects': { count: 7, noun: 'low thing', nounPlural: 'low things', tone: 'warning' },
    });
    render(<DashboardNav />);

    const inventory = screen.getByTestId('nav-count-/inventory').className;
    expect(inventory).toContain('bg-destructive');
    expect(inventory).toContain('text-destructive-foreground');

    const projects = screen.getByTestId('nav-count-/projects').className;
    expect(projects).toContain('text-warning');
    // The problem tone replaces the group hue entirely.
    expect(projects).not.toContain('text-primary');
    // The spoken name still states what the number is — colour is never the only signal.
    expect(tile('/projects')).toHaveAttribute('aria-label', 'Projects — 7 low things');
  });
});

describe('DashboardNav — reorder & pin (backlog B1)', () => {
  it('persists a keyboard reorder within a group', () => {
    render(<DashboardNav />);
    customise();
    // Default primary order starts Inventory, Projects, … — arrow-up on Projects floats it
    // above Inventory, and the new arrangement is saved to the layout store.
    fireEvent.keyDown(screen.getByTestId('nav-tile-/projects'), { key: 'ArrowUp' });
    expect(persistedGroup('primary').slice(0, 2)).toEqual(['/projects', '/inventory']);
  });

  it('pins a tile to the top of its group', () => {
    render(<DashboardNav />);
    customise();
    // Reports is last in the primary group; pinning it floats it to the very top.
    fireEvent.click(screen.getByTestId('nav-pin-/reports'));
    expect(persistedGroup('primary')[0]).toBe('/reports');
    expect(useLayoutStore.getState().navTileOrder.find((p) => p.id === '/reports')?.pinned).toBe(true);
  });

  it('moves a tile into another group via the move-right control (touch-friendly)', () => {
    render(<DashboardNav />);
    customise();
    // The drop zone (the pointer-drag target) still names its group…
    expect(screen.getByTestId('nav-drop-end-manage')).toHaveTextContent(
      'Drop a tile here to add it to Manage',
    );
    // …but the touch/click path is the on-tile move buttons: nudging Reports right moves it out of
    // the Workspaces group into the next group (Manage). Native HTML5 drag never fired on touch (#11).
    fireEvent.click(screen.getByTestId('nav-move-/reports-right'));
    expect(persistedGroup('manage')).toContain('/reports');
    expect(persistedGroup('primary')).not.toContain('/reports');
  });

  it('reorders within a group via the move-up control', () => {
    render(<DashboardNav />);
    customise();
    // Default primary order starts Inventory, Projects, … — move-up on Projects floats it above
    // Inventory, exactly like the ArrowUp keyboard path.
    fireEvent.click(screen.getByTestId('nav-move-/projects-up'));
    expect(persistedGroup('primary').slice(0, 2)).toEqual(['/projects', '/inventory']);
  });

  it('disables the move controls at a group edge (first tile can’t move up or to a prior group)', () => {
    render(<DashboardNav />);
    customise();
    // Inventory is first in the primary (Workspaces) group, which is itself the first group.
    expect(screen.getByTestId('nav-move-/inventory-up')).toBeDisabled();
    expect(screen.getByTestId('nav-move-/inventory-left')).toBeDisabled();
  });

  it('never offers a hidden (feature-gated) tile for ordering', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardNav />);
    customise();
    // The gated tile is absent from the edit surface — it can't be dragged, keyed or pinned.
    expect(screen.queryByTestId('nav-tile-/projects')).toBeNull();
    expect(screen.queryByTestId('nav-pin-/projects')).toBeNull();
    // A sibling that is still enabled remains orderable.
    expect(screen.getByTestId('nav-tile-/inventory')).toBeTruthy();
  });

  it('resolves a stale saved order safely (drops unknown ids, keeps every real tile)', () => {
    // A saved order referencing a removed route plus only a couple of real tiles — must not
    // crash, must ignore the unknown id, and must still surface every current destination.
    useLayoutStore.setState({
      navTileOrder: [
        { id: '/ghost-route', group: 'primary', pinned: true },
        { id: '/reports', group: 'primary', pinned: false },
        { id: '/inventory', group: 'primary', pinned: false },
      ],
    });
    render(<DashboardNav />);
    // The unknown id renders nothing; the known tiles (and the ones that were missing from the
    // stored order, appended by reconcile) are all present.
    expect(tile('/reports')).not.toBeNull();
    expect(tile('/inventory')).not.toBeNull();
    expect(tile('/contacts')).not.toBeNull(); // was absent from the stored order → appended
    expect(document.querySelector('a[href="/ghost-route"]')).toBeNull();
  });

  it('announces a move for screen readers via a live region', () => {
    render(<DashboardNav />);
    customise();
    fireEvent.keyDown(screen.getByTestId('nav-tile-/projects'), { key: 'ArrowUp' });
    // The announce-only twin carries a spoken description of where the tile landed.
    expect(screen.getByText(/Projects moved to position 1 of/i)).toBeTruthy();
  });

  it('the single Customise button drives the shared hub edit mode (both boards)', () => {
    render(<DashboardNav />);
    // The button writes the shared store that the widget board (DashboardGrid) also reads, so
    // one toggle puts both boards into (and out of) edit mode.
    expect(useDashboardCustomise.getState().editing).toBe(false);
    fireEvent.click(screen.getByTestId('customise-nav'));
    expect(useDashboardCustomise.getState().editing).toBe(true);
    fireEvent.click(screen.getByTestId('customise-nav'));
    expect(useDashboardCustomise.getState().editing).toBe(false);
  });
});
