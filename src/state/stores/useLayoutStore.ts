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
// The leaf SQL module, not the `@/db/repositories` barrel: the allow-list is a plain string
// array, and importing it via the barrel would pull every repository class into this store
// (the same reason `usePreferencesStore` reaches for `repositories/constants` directly).
import { ITEM_SORT_FIELDS } from '@/db/repositories/item/sql';
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

/**
 * How the inventory list is *ordered* (issue #128) — a third axis alongside {@link LayoutDensity}
 * (how each item is drawn) and {@link GroupingMode} (how the list is arranged).
 *
 * The field set is the data layer's sortable allow-list (`ITEM_SORT_FIELDS`) plus `'default'`,
 * which means "no explicit sort" — not *unordered*, but the repository's own default ordering
 * (favourites first, then name/serial/created). The user-facing labels and per-field direction
 * semantics live in the `features/inventory/sorting.ts` descriptor SSOT.
 */
export const INVENTORY_SORT_FIELDS = ['default', ...ITEM_SORT_FIELDS] as const;

export type InventorySortField = (typeof INVENTORY_SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;

export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export interface InventorySort {
  readonly field: InventorySortField;
  readonly direction: SortDirection;
}

/** The ordering the inventory opens in before the user picks one. */
export const DEFAULT_INVENTORY_SORT: InventorySort = { field: 'default', direction: 'asc' };

/**
 * Reconcile a persisted/unknown sort against the live shape — see {@link normaliseDensity}.
 * Unlike the scalar prefs this is an *object*, so both members are reconciled independently
 * and a non-object (or a field dropped from the allow-list) falls back to the default order
 * rather than reaching `itemOrderByClause`, which indexes its column table by the field name.
 */
export function normaliseInventorySort(value: unknown): InventorySort {
  if (typeof value !== 'object' || value === null) return DEFAULT_INVENTORY_SORT;
  const v = value as Partial<Record<keyof InventorySort, unknown>>;
  const field = normaliseOneOf(v.field, INVENTORY_SORT_FIELDS, DEFAULT_INVENTORY_SORT.field);
  // A recognised field with an unrecognised direction is still usable — keep the field and
  // fall back to ascending rather than discarding the user's whole choice.
  const direction = normaliseOneOf(v.direction, SORT_DIRECTIONS, DEFAULT_INVENTORY_SORT.direction);
  return field === 'default' ? DEFAULT_INVENTORY_SORT : { field, direction };
}

interface LayoutStore {
  readonly density: LayoutDensity;
  /** How the inventory grid arranges items (grouping axis). Persisted like `density`. */
  readonly grouping: GroupingMode;
  /** How the inventory list is ordered (sort axis, issue #128). Persisted like `density`. */
  readonly inventorySort: InventorySort;
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
  setInventorySort: (sort: InventorySort) => void;
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
      inventorySort: DEFAULT_INVENTORY_SORT,
      sidebarCollapsed: false,
      inventoryLocationCard: true,
      dashboardLayout: [],
      navTileOrder: [],
      setDensity: (density) => set({ density: normaliseDensity(density) }),
      toggleDensity: () => set((state) => ({ density: state.density === 'data' ? 'visual' : 'data' })),
      setGrouping: (grouping) => set({ grouping: normaliseGrouping(grouping) }),
      setInventorySort: (sort) => set({ inventorySort: normaliseInventorySort(sort) }),
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
          inventorySort: normaliseInventorySort(p.inventorySort),
          sidebarCollapsed: normaliseBoolean(p.sidebarCollapsed, current.sidebarCollapsed),
          inventoryLocationCard: normaliseBoolean(p.inventoryLocationCard, current.inventoryLocationCard),
          dashboardLayout: normaliseArray<DashboardLayout[number]>(p.dashboardLayout),
          navTileOrder: normaliseArray<NavOrder[number]>(p.navTileOrder),
        };
      },
    },
  ),
);
