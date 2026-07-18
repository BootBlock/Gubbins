/**
 * useLayoutStore — Tier-2 global UI layout state (spec §2.1, §3 "Adaptive Density",
 * §3 "Customisable Dashboard").
 *
 * Owns the Data-Heavy ↔ Visual-Heavy density toggle, sidebar collapse state, and the
 * **dashboard widget layout coordinates** (§2.1 names this store as their home),
 * persisted to localStorage so the user's chosen layout survives reloads. Kept
 * deliberately small and domain-specific — no god store (§2.1). The widget grid
 * coordinate maths lives in the pure `features/dashboard/dashboard-layout.ts` seam;
 * this store only persists the resulting placements (device-local — no DB migration).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DashboardLayout } from '@/features/dashboard/dashboard-layout';
import type { NavOrder } from '@/features/dashboard/dashboard-nav-order';
import { adoptUnversioned, normaliseArray, normaliseBoolean, normaliseOneOf } from '@/lib/persisted-state';

/**
 * The inventory "View" axis — how the collection is presented (orthogonal to {@link GroupingMode}).
 * It spans two kinds of view: the **per-item** modes that draw one item each (see {@link ItemDensity})
 * and the **whole-collection** visualisations that draw the inventory as a single picture:
 *
 * - `visual` — large image cards, ample whitespace (the "Visual-Heavy" view).
 * - `data` — dense, one-per-line rows optimised for scanning many records (the "Data-Heavy" view).
 * - `table` — a spreadsheet-style grid: aligned columns under a sticky header, one row per item.
 * - `map` — a spatial map of the location hierarchy: nested tiles sized by how much stock sits in
 *   each place and tinted by how full it is — a "where is my stuff / what's full" lens.
 * - `treemap` — a value treemap: tiles whose area is proportional to the stock value they hold,
 *   grouped by category (or by location under the grouping axis).
 */
export const LAYOUT_DENSITIES = ['data', 'visual', 'table', 'map', 'treemap'] as const;

export type LayoutDensity = (typeof LAYOUT_DENSITIES)[number];

/** The view the inventory opens in before the user picks one. */
export const DEFAULT_DENSITY: LayoutDensity = 'visual';

/**
 * Reconcile a persisted/unknown density against the live union, falling back to
 * {@link DEFAULT_DENSITY}. Rehydrated `localStorage` is untyped (see `lib/persisted-state`), and
 * a value from an older release or a hand-edit would otherwise reach the per-density row-height
 * table — which the {@link ItemDensity} doc below relies on being exhaustive.
 */
export function normaliseDensity(value: unknown): LayoutDensity {
  return normaliseOneOf(value, LAYOUT_DENSITIES, DEFAULT_DENSITY);
}

/**
 * The subset of {@link LayoutDensity} that draws the inventory **item by item** — the modes the
 * virtualised {@link ItemList} / grouped list actually render. The two whole-collection
 * visualisations (`map`, `treemap`) are intercepted by the inventory screen and rendered by their
 * own components, so the per-item render paths never receive them; typing their `density` prop as
 * `ItemDensity` keeps that guarantee in the type system (e.g. the per-density row-height table stays
 * exhaustive).
 */
export type ItemDensity = Exclude<LayoutDensity, 'map' | 'treemap'>;

/**
 * How the inventory grid *arranges* items — an axis orthogonal to {@link LayoutDensity}
 * (which governs how each item is *drawn*). Designed to grow: today `none` (a flat list)
 * and `location` (collapsible sections mirroring the location hierarchy); future modes
 * (by category, by tag, …) slot in here and into the `GROUP_MODES` descriptor SSOT
 * (`features/inventory/grouping.ts`) without touching the render fork.
 */
export const GROUPING_MODES = ['none', 'location'] as const;

export type GroupingMode = (typeof GROUPING_MODES)[number];

/** The arrangement the inventory opens in before the user picks one. */
export const DEFAULT_GROUPING: GroupingMode = 'none';

/** Reconcile a persisted/unknown grouping against the live union — see {@link normaliseDensity}. */
export function normaliseGrouping(value: unknown): GroupingMode {
  return normaliseOneOf(value, GROUPING_MODES, DEFAULT_GROUPING);
}

interface LayoutStore {
  readonly density: LayoutDensity;
  /** How the inventory grid arranges items (grouping axis). Persisted like `density`. */
  readonly grouping: GroupingMode;
  readonly sidebarCollapsed: boolean;
  /**
   * Whether the compact per-location info card sits atop the inventory list when a location
   * is selected (its fullness gauge, path, last-changed, …). A device-local view preference
   * like {@link density}; defaults **on** so it's discoverable, and the user can dismiss it
   * from the card itself or the inventory "More" menu.
   */
  readonly inventoryLocationCard: boolean;
  /**
   * Persisted dashboard widget placements (spec §3, §2.1). Empty until the user
   * customises (or the board is first reconciled against the registry); the dashboard
   * reconciles this against the live widget registry on render so it survives the
   * registry changing across releases.
   */
  readonly dashboardLayout: DashboardLayout;
  /**
   * Persisted dashboard **nav-tile** arrangement (backlog B1) — reorder, cross-group move
   * and pin, kept alongside `dashboardLayout` as a sibling per-device layout concern. Empty
   * until the user customises; {@link DashboardNav} reconciles it against the live nav
   * destinations (and Modular UI gating) on render, so it survives the tile set changing.
   */
  readonly navTileOrder: NavOrder;
  setDensity: (density: LayoutDensity) => void;
  toggleDensity: () => void;
  setGrouping: (grouping: GroupingMode) => void;
  toggleSidebar: () => void;
  toggleInventoryLocationCard: () => void;
  setDashboardLayout: (layout: DashboardLayout) => void;
  setNavTileOrder: (order: NavOrder) => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      density: DEFAULT_DENSITY,
      grouping: DEFAULT_GROUPING,
      sidebarCollapsed: false,
      inventoryLocationCard: true,
      dashboardLayout: [],
      navTileOrder: [],
      setDensity: (density) => set({ density: normaliseDensity(density) }),
      toggleDensity: () => set((state) => ({ density: state.density === 'data' ? 'visual' : 'data' })),
      setGrouping: (grouping) => set({ grouping: normaliseGrouping(grouping) }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleInventoryLocationCard: () =>
        set((state) => ({ inventoryLocationCard: !state.inventoryLocationCard })),
      setDashboardLayout: (dashboardLayout) => set({ dashboardLayout }),
      setNavTileOrder: (navTileOrder) => set({ navTileOrder }),
    }),
    {
      name: 'gubbins:layout',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
      // Rehydrated JSON is untyped, so reconcile every persisted field against its live shape
      // rather than merging it over the defaults verbatim. `dashboardLayout` / `navTileOrder`
      // are only array-checked here — their *members* are reconciled against the live widget
      // and nav registries on render, which is where a stale tile id has to be resolved anyway.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Record<keyof LayoutStore, unknown>>;
        return {
          ...current,
          density: normaliseDensity(p.density),
          grouping: normaliseGrouping(p.grouping),
          sidebarCollapsed: normaliseBoolean(p.sidebarCollapsed, current.sidebarCollapsed),
          inventoryLocationCard: normaliseBoolean(p.inventoryLocationCard, current.inventoryLocationCard),
          dashboardLayout: normaliseArray<DashboardLayout[number]>(p.dashboardLayout),
          navTileOrder: normaliseArray<NavOrder[number]>(p.navTileOrder),
        };
      },
    },
  ),
);
