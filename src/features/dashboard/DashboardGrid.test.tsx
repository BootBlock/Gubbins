import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

// Plain-anchor Link so the grid renders without a RouterProvider. The `href` lets us assert
// whether a tile is a live quick-link or a dropped (non-clickable) one, and it carries any
// `search` the widget declared so the pre-scoped tiles can be told apart from the plain ones.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, unknown>;
    [k: string]: unknown;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search as Record<string, string>)}` : to} {...props}>
      {children}
    </a>
  ),
}));

// The set of "all clear" widget ids the mocked `useHealthyWidgetIds` reports — the
// "hide healthy cards" tests (issue #111) drive it to control which cards are dropped.
let mockHealthyIds = new Set<string>();

// A controlled widget registry so this test exercises the grid's gating logic — not the
// real widgets' data hooks. `featureForRoute` (from the real registry) still resolves the
// `to` targets below, so the dead-link path is tested end to end against real route data.
vi.mock('./widgets', () => {
  const defs = [
    // Ungated widget with a core-route link — always on the board, link always live.
    { id: 'alpha', title: 'Alpha', icon: null, to: '/inventory', Component: () => <p>Alpha body</p> },
    // Same shape as alpha, but carries `search` (mirrors the In-Transit widget landing the
    // Inventory screen scoped to one location rather than on the plain list).
    {
      id: 'delta',
      title: 'Delta',
      icon: null,
      to: '/inventory',
      search: { loc: 'loc-1' },
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
    // Gated on a read permission rather than a module (issue #522) — disappears entirely for a
    // role that cannot view the audit trail, exactly as `/activity` itself does.
    {
      id: 'tau',
      title: 'Tau',
      icon: null,
      to: '/activity',
      permission: 'audit:view',
      Component: () => <p>Tau body</p>,
    },
    // A tile targeting `/settings` — Settings is a dialog, so this must render as a button
    // that opens the dialog, never a `<Link>` (a link prefetch-opens it on hover).
    { id: 'sigma', title: 'Sigma', icon: null, to: '/settings', Component: () => <p>Sigma body</p> },
    // Same shape as sigma, but carries a `settingsTab` (mirrors the Storage widget landing
    // on the "Data & storage" rail tab instead of the default Appearance one — issue #63).
    {
      id: 'omega',
      title: 'Omega',
      icon: null,
      to: '/settings',
      settingsTab: 'storage',
      Component: () => <p>Omega body</p>,
    },
  ];
  return {
    DASHBOARD_WIDGETS: defs,
    DASHBOARD_WIDGET_IDS: defs.map((d) => d.id),
    widgetById: (id: string) => defs.find((d) => d.id === id),
    // "Hide healthy cards" probe (issue #111) — driven by the mutable set above.
    useHealthyWidgetIds: () => mockHealthyIds,
    // Stand-in for a tile whose render crashed (#313) — the grid hands this to each tile's
    // boundary as its fallback. Exercised in `DashboardGrid.crash.test.tsx`.
    WidgetCrashFallback: ({ title }: { title: string }) => <p>{title} unavailable</p>,
  };
});

import { DashboardGrid } from './DashboardGrid';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useDashboardCustomise } from './useDashboardCustomise';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

/** The widget board no longer owns the Customise toggle — enter edit mode via the shared store. */
function enterCustomise(): void {
  act(() => useDashboardCustomise.setState({ editing: true }));
}

beforeEach(() => {
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ dashboardLayout: [] });
  useDashboardCustomise.setState({ editing: false });
  usePreferencesStore.setState({ hideHealthyDashboardCards: false });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
  mockHealthyIds = new Set<string>();
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {} });
  useLayoutStore.setState({ dashboardLayout: [] });
  useDashboardCustomise.setState({ editing: false });
  useSettingsDialog.setState({ open: false, initialTab: undefined });
  usePreferencesStore.setState({ hideHealthyDashboardCards: false });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
  mockHealthyIds = new Set<string>();
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

  it('opens Settings on a widget’s `settingsTab` when it declares one (issue #63)', () => {
    render(<DashboardGrid />);
    const button = screen.getByTestId('widget-omega').closest('button');
    expect(useSettingsDialog.getState().initialTab).toBeUndefined();
    fireEvent.click(button as HTMLButtonElement);
    expect(useSettingsDialog.getState().open).toBe(true);
    expect(useSettingsDialog.getState().initialTab).toBe('storage');
  });

  it('carries a widget’s `search` into its quick-link, so the tile lands pre-scoped', () => {
    render(<DashboardGrid />);
    expect(tileLink('delta')?.getAttribute('href')).toBe('/inventory?loc=loc-1');
    // A widget declaring no `search` still links to the plain screen.
    expect(tileLink('alpha')?.getAttribute('href')).toBe('/inventory');
  });
});

describe('DashboardGrid — gated coords survive edits (Phase 4)', () => {
  const seeded = [
    { id: 'alpha', x: 0, y: 0, w: 1, h: 1, visible: true },
    { id: 'beta', x: 1, y: 0, w: 1, h: 1, visible: true },
    { id: 'gamma', x: 2, y: 0, w: 1, h: 1, visible: true },
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
    expect(persisted.find((p) => p.id === 'beta')).toEqual({
      id: 'beta',
      x: 1,
      y: 0,
      w: 1,
      h: 1,
      visible: true,
    });
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
      w: 1,
      h: 1,
      visible: true,
    });
  });

  /** Every cell claimed by a visible placement, as `x,y` keys — one entry per stacked tile. */
  function visibleCells(): string[] {
    return useLayoutStore
      .getState()
      .dashboardLayout.filter((p) => p.visible)
      .map((p) => `${p.x},${p.y}`);
  }

  // Issue #627: the gated widget's cell used to look free to the coordinate ops, so an edit
  // made while its module was off could put a second widget on it — and switching the module
  // back on then drew the two tiles stacked, the underneath one unreadable and unclickable.
  it('treats a gated widget’s cell as occupied when another tile is moved onto it', () => {
    useLayoutStore.setState({ dashboardLayout: seeded });
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);
    enterCustomise();

    // Gamma sits at (2,0); move it left onto (1,0), which the gated Beta holds.
    fireEvent.click(screen.getByTestId('widget-move-gamma-left'));

    const persisted = useLayoutStore.getState().dashboardLayout;
    expect(persisted.find((p) => p.id === 'gamma')).toMatchObject({ x: 1, y: 0 });
    // Beta is displaced into the cell Gamma vacated rather than buried underneath it.
    expect(persisted.find((p) => p.id === 'beta')).toEqual({
      id: 'beta',
      x: 2,
      y: 0,
      w: 1,
      h: 1,
      visible: true,
    });
    expect(new Set(visibleCells()).size).toBe(visibleCells().length);
  });

  it('never re-homes an added-back widget onto a gated widget’s cell', () => {
    useLayoutStore.setState({
      dashboardLayout: [
        { id: 'beta', x: 0, y: 0, w: 1, h: 1, visible: true },
        { id: 'alpha', x: 1, y: 0, w: 1, h: 1, visible: true },
      ],
    });
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);
    enterCustomise();

    // Hide Alpha, then add it back. (0,0) looks free with Beta gated out — it is not.
    fireEvent.click(screen.getByTestId('widget-hide-alpha'));
    fireEvent.click(screen.getByTestId('widget-add-alpha'));

    expect(useLayoutStore.getState().dashboardLayout).toContainEqual({
      id: 'alpha',
      x: 1,
      y: 0,
      w: 1,
      h: 1,
      visible: true,
    });

    // Turning Projects back on brings Beta back to its own cell, with nothing on top of it.
    act(() => {
      useModulesStore.getState().setFeatureIntent('projects', true);
    });
    expect(new Set(visibleCells()).size).toBe(visibleCells().length);
  });

  it('draws no empty drop cell over a gated widget’s cell', () => {
    useLayoutStore.setState({ dashboardLayout: seeded });
    useModulesStore.getState().setFeatureIntent('projects', false);
    render(<DashboardGrid />);
    enterCustomise();

    // Beta is gated out of (1,0) — the 1-based CSS variables for that cell are (2,1).
    const cells = screen.getAllByTestId('dashboard-drop-cell');
    expect(cells.length).toBeGreaterThan(0);
    const overBeta = cells.filter(
      (el) => el.style.getPropertyValue('--gx') === '2' && el.style.getPropertyValue('--gy') === '1',
    );
    expect(overBeta).toHaveLength(0);
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

describe('DashboardGrid — hide healthy cards (issue #111)', () => {
  it('keeps every card on the board when the option is off, whatever the probe reports', () => {
    // The option is off (default), so even a reported-healthy card stays shown — and the
    // probe isn't even mounted, so its set is irrelevant.
    mockHealthyIds = new Set(['gamma']);
    render(<DashboardGrid />);
    expect(screen.getByTestId('widget-gamma')).toBeInTheDocument();
    expect(screen.getByTestId('widget-alpha')).toBeInTheDocument();
  });

  it('hides an all-clear card in view mode, leaving the others on the board', () => {
    usePreferencesStore.setState({ hideHealthyDashboardCards: true });
    mockHealthyIds = new Set(['gamma']);
    render(<DashboardGrid />);
    expect(screen.queryByTestId('widget-gamma')).toBeNull();
    expect(screen.queryByText('Gamma body')).toBeNull();
    // Every card with something to report stays.
    expect(screen.getByTestId('widget-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('widget-beta')).toBeInTheDocument();
  });

  it('still shows every card while customising, so the board can be arranged', () => {
    usePreferencesStore.setState({ hideHealthyDashboardCards: true });
    mockHealthyIds = new Set(['gamma']);
    render(<DashboardGrid />);
    // Hidden in view mode…
    expect(screen.queryByTestId('widget-gamma')).toBeNull();
    // …but Customise mode ignores the healthy set so the card can be moved/hidden manually.
    enterCustomise();
    expect(screen.getByTestId('widget-gamma')).toBeInTheDocument();
  });

  it('never rewrites the persisted layout when it hides an all-clear card', () => {
    const seeded = [
      { id: 'alpha', x: 0, y: 0, w: 1, h: 1, visible: true },
      { id: 'gamma', x: 1, y: 0, w: 1, h: 1, visible: true },
    ];
    useLayoutStore.setState({ dashboardLayout: seeded });
    usePreferencesStore.setState({ hideHealthyDashboardCards: true });
    mockHealthyIds = new Set(['gamma']);
    render(<DashboardGrid />);
    // Hiding is a render-only transform — the stored coordinates are untouched, so turning
    // the option back off (or clearing the alert) restores the card exactly where it was.
    expect(useLayoutStore.getState().dashboardLayout).toEqual(seeded);
  });
});

describe('DashboardGrid — touch-friendly move controls (issue #11)', () => {
  it('nudges a widget one cell via the move buttons (the drag-free reorder path)', () => {
    // Alpha at (0,0), Delta at (1,0); the rest flow after. Moving Alpha right swaps it with Delta.
    useLayoutStore.setState({
      dashboardLayout: [
        { id: 'alpha', x: 0, y: 0, w: 1, h: 1, visible: true },
        { id: 'delta', x: 1, y: 0, w: 1, h: 1, visible: true },
      ],
    });
    render(<DashboardGrid />);
    enterCustomise();

    fireEvent.click(screen.getByTestId('widget-move-alpha-right'));

    const layout = useLayoutStore.getState().dashboardLayout;
    expect(layout.find((p) => p.id === 'alpha')).toMatchObject({ x: 1, y: 0 });
    expect(layout.find((p) => p.id === 'delta')).toMatchObject({ x: 0, y: 0 });
  });

  it('disables a move control that would push a widget off the grid', () => {
    useLayoutStore.setState({ dashboardLayout: [{ id: 'alpha', x: 0, y: 0, w: 1, h: 1, visible: true }] });
    render(<DashboardGrid />);
    enterCustomise();
    // Alpha sits in the top-left corner: it can move neither up nor left.
    expect(screen.getByTestId('widget-move-alpha-up')).toBeDisabled();
    expect(screen.getByTestId('widget-move-alpha-left')).toBeDisabled();
  });

  it('announces where a moved widget landed (issue #218)', () => {
    useLayoutStore.setState({
      dashboardLayout: [
        { id: 'alpha', x: 0, y: 0, w: 1, h: 1, visible: true },
        { id: 'delta', x: 1, y: 0, w: 1, h: 1, visible: true },
      ],
    });
    render(<DashboardGrid />);
    enterCustomise();
    // The region pre-exists (screen readers ignore one inserted alongside its first message).
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');

    fireEvent.click(screen.getByTestId('widget-move-alpha-right'));
    expect(live.textContent).toContain('column 2 of 3, row 1');

    fireEvent.click(screen.getByTestId('widget-move-alpha-down'));
    expect(live.textContent).toContain('column 2 of 3, row 2');
  });

  it('says nothing when a move is clamped at an edge (nothing changed)', () => {
    useLayoutStore.setState({ dashboardLayout: [{ id: 'alpha', x: 0, y: 0, w: 1, h: 1, visible: true }] });
    render(<DashboardGrid />);
    enterCustomise();
    // The up control is disabled, so drive the clamped nudge through the keyboard path.
    fireEvent.keyDown(screen.getByTestId('widget-alpha'), { key: 'ArrowUp' });
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

/**
 * Issue #522: the Dashboard carries no read gate of its own — it is where a refused screen
 * sends people — so a widget summarising a subject the role cannot view has to drop itself,
 * or the board shows the very ledger `/activity` just withheld.
 */
describe('DashboardGrid — read permissions', () => {
  it('drops a widget whose read permission the session lacks, from the board and the picker', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['items:read']) } });
    render(<DashboardGrid />);

    expect(screen.queryByTestId('widget-tau')).toBeNull();
    expect(screen.getByTestId('widget-alpha')).toBeInTheDocument();

    enterCustomise();
    expect(screen.queryByTestId('widget-add-tau')).toBeNull();
  });

  it('keeps the widget when the role grants its permission', () => {
    useSessionStore.setState({
      authority: { mode: 'granted', grants: new Set(['items:read', 'audit:view']) },
    });
    render(<DashboardGrid />);
    expect(screen.getByTestId('widget-tau')).toBeInTheDocument();
  });

  it('drops a surviving widget’s quick-link into a route the role cannot read', () => {
    // `gamma` itself is ungated, but it links to /reports — which needs `reports:read`.
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['items:read']) } });
    render(<DashboardGrid />);

    expect(screen.getByTestId('widget-gamma')).toBeInTheDocument();
    expect(tileLink('gamma')).toBeNull();
    // The core-inventory link stays live: `items:read` covers /inventory.
    expect(tileLink('alpha')?.getAttribute('href')).toBe('/inventory');
  });
});

// --- Resizable cards (issue #441) ----------------------------------------------------
//
// The default layout of the mocked registry is alpha(0,0) delta(1,0) beta(2,0) on the top
// row, gamma(0,1) tau(1,1) sigma(2,1) on the next, and omega alone at (0,2) — so omega has
// room to grow in every direction and alpha is boxed in on its right by delta.
describe('DashboardGrid — resizable cards (issue #441)', () => {
  /** The persisted placement for `id`, after the board has written a layout. */
  function placement(id: string) {
    return useLayoutStore.getState().dashboardLayout.find((p) => p.id === id);
  }

  it('offers the size picker only while the board is being customised', () => {
    render(<DashboardGrid />);
    expect(screen.queryByTestId('widget-size-omega-2x1')).toBeNull();

    enterCustomise();
    expect(screen.getByTestId('widget-size-omega-2x1')).toBeInTheDocument();
  });

  it('marks the size the card currently has as pressed', () => {
    render(<DashboardGrid />);
    enterCustomise();
    expect(screen.getByTestId('widget-size-omega-1x1')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('widget-size-omega-2x2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('resizes the card and persists the new span', () => {
    render(<DashboardGrid />);
    enterCustomise();
    fireEvent.click(screen.getByTestId('widget-size-omega-2x2'));

    expect(placement('omega')).toMatchObject({ id: 'omega', x: 0, y: 2, w: 2, h: 2 });
  });

  it('spans the grid cells it was given, and stops spanning when shrunk back', () => {
    render(<DashboardGrid />);
    enterCustomise();
    fireEvent.click(screen.getByTestId('widget-size-omega-2x2'));
    expect(screen.getByTestId('widget-omega').getAttribute('style')).toContain('--gw: 2');
    expect(screen.getByTestId('widget-omega').getAttribute('style')).toContain('--gh: 2');

    fireEvent.click(screen.getByTestId('widget-size-omega-1x1'));
    expect(screen.getByTestId('widget-omega').getAttribute('style')).toContain('--gw: 1');
    expect(placement('omega')).toMatchObject({ w: 1, h: 1 });
  });

  it('disables a size the card cannot take, rather than hiding it', () => {
    render(<DashboardGrid />);
    enterCustomise();
    // Alpha sits at (0,0) with Delta immediately to its right, so it cannot widen.
    expect(screen.getByTestId('widget-size-alpha-2x1')).toBeDisabled();
    expect(screen.getByTestId('widget-size-alpha-1x1')).toBeEnabled();
  });

  it('leaves a refused resize unpersisted', () => {
    useLayoutStore.setState({ dashboardLayout: [] });
    render(<DashboardGrid />);
    enterCustomise();
    fireEvent.click(screen.getByTestId('widget-size-alpha-2x1'));

    // Nothing was written at all: the pure op returned the same layout it was handed.
    expect(useLayoutStore.getState().dashboardLayout).toEqual([]);
  });

  it('resizes from the keyboard with Shift and the arrow keys', () => {
    render(<DashboardGrid />);
    enterCustomise();
    const tile = screen.getByTestId('widget-omega');

    fireEvent.keyDown(tile, { key: 'ArrowRight', shiftKey: true });
    expect(placement('omega')).toMatchObject({ w: 2, h: 1 });

    fireEvent.keyDown(tile, { key: 'ArrowDown', shiftKey: true });
    expect(placement('omega')).toMatchObject({ w: 2, h: 2 });

    fireEvent.keyDown(tile, { key: 'ArrowLeft', shiftKey: true });
    expect(placement('omega')).toMatchObject({ w: 1, h: 2 });
  });

  it('still moves the tile when the same arrow key is pressed without Shift', () => {
    render(<DashboardGrid />);
    enterCustomise();
    fireEvent.keyDown(screen.getByTestId('widget-omega'), { key: 'ArrowRight' });

    expect(placement('omega')).toMatchObject({ x: 1, y: 2, w: 1, h: 1 });
  });

  it('announces the new size for a screen reader', () => {
    render(<DashboardGrid />);
    enterCustomise();
    fireEvent.click(screen.getByTestId('widget-size-omega-2x1'));

    expect(screen.getByText(/resized to a 2 by 1 card/)).toBeInTheDocument();
  });

  it('keeps a resized card off every other card when the board is re-read', () => {
    render(<DashboardGrid />);
    enterCustomise();
    fireEvent.click(screen.getByTestId('widget-size-omega-2x2'));

    // Every cell claimed by a visible placement, counting each cell of a multi-cell card.
    const cells = useLayoutStore
      .getState()
      .dashboardLayout.filter((p) => p.visible)
      .flatMap((p) =>
        Array.from({ length: p.w * p.h }, (_, i) => `${p.x + (i % p.w)},${p.y + Math.floor(i / p.w)}`),
      );
    expect(new Set(cells).size).toBe(cells.length);
  });
});
