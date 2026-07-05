import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// Plain-anchor Link so the grid renders without a RouterProvider; the `href` lets us
// assert whether a tile is a live quick-link or a dropped (non-clickable) one.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// A spy the synthetic `delta` widget's `onLinkClick` calls, so the test below can assert
// the grid actually wires it to the rendered Link's onClick.
const mockDeltaLinkClick = vi.fn();

// A controlled widget registry so this test exercises the grid's gating logic — not the
// real widgets' data hooks. `featureForRoute` (from the real registry) still resolves the
// `to` targets below, so the dead-link path is tested end to end against real route data.
vi.mock('./widgets', () => {
  const defs = [
    // Ungated widget with a core-route link — always on the board, link always live.
    { id: 'alpha', title: 'Alpha', icon: null, to: '/inventory', Component: () => <p>Alpha body</p> },
    // Same shape as alpha, but carries an `onLinkClick` (mirrors the In-Transit widget
    // handing a one-shot location intent to the Inventory screen before navigating).
    {
      id: 'delta',
      title: 'Delta',
      icon: null,
      to: '/inventory',
      onLinkClick: () => mockDeltaLinkClick(),
      Component: () => <p>Delta body</p>,
    },
    // Gated on `projects` — disappears entirely when Projects is off.
    {
      id: 'beta',
      title: 'Beta',
      icon: null,
      to: '/projects',
      feature: 'projects',
      Component: () => <p>Beta body</p>,
    },
    // Ungated widget whose link targets `/reports` — survives when Reports is off, but its
    // link must drop (the dead-link case).
    { id: 'gamma', title: 'Gamma', icon: null, to: '/reports', Component: () => <p>Gamma body</p> },
    // A tile targeting `/settings` — Settings is a dialog, so this must render as a button
    // that opens the dialog, never a `<Link>` (a link prefetch-opens it on hover).
    { id: 'sigma', title: 'Sigma', icon: null, to: '/settings', Component: () => <p>Sigma body</p> },
  ];
  return {
    DASHBOARD_WIDGETS: defs,
    DASHBOARD_WIDGET_IDS: defs.map((d) => d.id),
    widgetById: (id: string) => defs.find((d) => d.id === id),
  };
});

import { DashboardGrid } from './DashboardGrid';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useDashboardCustomise } from './useDashboardCustomise';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';

/** The widget board no longer owns the Customise toggle — enter edit mode via the shared store. */
function enterCustomise(): void {
  act(() => useDashboardCustomise.setState({ editing: true }));
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ dashboardLayout: [] });
  useDashboardCustomise.setState({ editing: false });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ dashboardLayout: [] });
  useDashboardCustomise.setState({ editing: false });
  useSettingsDialog.setState({ open: false });
});

/** The `<a>` wrapping a tile, or `null` when the tile isn't a live link. */
function tileLink(id: string): HTMLAnchorElement | null {
  return screen.getByTestId(`widget-${id}`).closest('a');
}

describe('DashboardGrid — widget feature gating (Phase 4)', () => {
  it('renders every widget with its live quick-link when all modules are on', () => {
    render(<DashboardGrid />);
    expect(screen.getByTestId('widget-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('widget-beta')).toBeInTheDocument();
    expect(screen.getByTestId('widget-gamma')).toBeInTheDocument();
    expect(tileLink('alpha')?.getAttribute('href')).toBe('/inventory');
    expect(tileLink('beta')?.getAttribute('href')).toBe('/projects');
    expect(tileLink('gamma')?.getAttribute('href')).toBe('/reports');
  });

  it('drops a widget from the board when its module is off', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);
    expect(screen.queryByTestId('widget-beta')).toBeNull();
    expect(screen.queryByText('Beta body')).toBeNull();
    // The surviving widgets are untouched.
    expect(screen.getByTestId('widget-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('widget-gamma')).toBeInTheDocument();
  });

  it('omits a gated widget from the Customise "Hidden widgets" picker', () => {
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);
    enterCustomise();
    // A gated widget is neither on the board nor offered as re-addable in the picker.
    expect(screen.queryByTestId('widget-add-beta')).toBeNull();
    expect(screen.queryByText('Beta body')).toBeNull();
  });

  it('drops a surviving widget’s link when its target route is hidden', () => {
    useModulesStore.getState().setFeatureIntent('reports', false);
    render(<DashboardGrid />);
    // Gamma stays (it is ungated) but is no longer a link into the hidden Reports module.
    expect(screen.getByTestId('widget-gamma')).toBeInTheDocument();
    expect(tileLink('gamma')).toBeNull();
    // A widget whose link targets a still-enabled (core) route keeps its link.
    expect(tileLink('alpha')?.getAttribute('href')).toBe('/inventory');
  });

  it('renders a `/settings` tile as a dialog-opening button, never a Link (no hover prefetch)', () => {
    render(<DashboardGrid />);
    const tile = screen.getByTestId('widget-sigma');
    // Crucially not wrapped in an `<a>` — a Link would prefetch-open the dialog on hover
    // (the `/settings` route's `beforeLoad` raises it under `defaultPreload: 'intent'`).
    expect(tileLink('sigma')).toBeNull();
    const button = tile.closest('button');
    expect(button).not.toBeNull();

    // The dialog is only raised on an actual click, not merely by rendering/hovering.
    expect(useSettingsDialog.getState().open).toBe(false);
    fireEvent.click(button as HTMLButtonElement);
    expect(useSettingsDialog.getState().open).toBe(true);
  });

  it('fires a widget’s onLinkClick (e.g. a one-shot destination intent) just before it navigates', () => {
    render(<DashboardGrid />);
    expect(mockDeltaLinkClick).not.toHaveBeenCalled();
    fireEvent.click(tileLink('delta') as HTMLAnchorElement);
    expect(mockDeltaLinkClick).toHaveBeenCalledTimes(1);
  });
});

describe('DashboardGrid — gated coords survive edits (Phase 4)', () => {
  const seeded = [
    { id: 'alpha', x: 0, y: 0, visible: true },
    { id: 'beta', x: 1, y: 0, visible: true },
    { id: 'gamma', x: 2, y: 0, visible: true },
  ];

  it('never rewrites a gated widget’s stored coordinates when the board is edited', () => {
    useLayoutStore.setState({ dashboardLayout: seeded });
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);

    // Edit the visible board: hide Gamma. This persists a new layout — the gated Beta must
    // ride along untouched so re-enabling Projects restores its exact placement.
    enterCustomise();
    fireEvent.click(screen.getByTestId('widget-hide-gamma'));

    const persisted = useLayoutStore.getState().dashboardLayout;
    expect(persisted.find((p) => p.id === 'beta')).toEqual({ id: 'beta', x: 1, y: 0, visible: true });
    expect(persisted.find((p) => p.id === 'gamma')).toMatchObject({ id: 'gamma', visible: false });
  });

  it('restores a widget at its prior coordinates when its module is turned back on', () => {
    useLayoutStore.setState({ dashboardLayout: seeded });
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);
    expect(screen.queryByTestId('widget-beta')).toBeNull();

    // Turn Projects back on — the subscribed grid re-renders and Beta reappears; its stored
    // coords were never mutated, so it lands back where it was.
    act(() => {
      useModulesStore.getState().setFeatureIntent('projects', true);
    });
    expect(screen.getByTestId('widget-beta')).toBeInTheDocument();
    expect(useLayoutStore.getState().dashboardLayout.find((p) => p.id === 'beta')).toEqual({
      id: 'beta',
      x: 1,
      y: 0,
      visible: true,
    });
  });
});

describe('DashboardGrid — shared Customise mode', () => {
  it('has no Customise button of its own; edit mode comes from the shared store', () => {
    render(<DashboardGrid />);
    // The board's own toggle is gone (a single button up in DashboardNav drives both boards).
    expect(screen.queryByTestId('customise-dashboard')).toBeNull();
    // In view mode there are no per-widget edit affordances…
    expect(screen.queryByTestId('widget-hide-alpha')).toBeNull();
    // …but flipping the shared store puts this board into edit mode.
    enterCustomise();
    expect(screen.getByTestId('widget-hide-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('reset-dashboard')).toBeInTheDocument();
  });
});
