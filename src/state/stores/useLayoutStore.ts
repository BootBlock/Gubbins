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

/**
 * - `data` — dense, tabular layouts (the "Data-Heavy" view).
 * - `visual` — large image cards, ample whitespace (the "Visual-Heavy" view).
 */
export type LayoutDensity = 'data' | 'visual';

interface LayoutStore {
  readonly density: LayoutDensity;
  readonly sidebarCollapsed: boolean;
  /**
   * Persisted dashboard widget placements (spec §3, §2.1). Empty until the user
   * customises (or the board is first reconciled against the registry); the dashboard
   * reconciles this against the live widget registry on render so it survives the
   * registry changing across releases.
   */
  readonly dashboardLayout: DashboardLayout;
  setDensity: (density: LayoutDensity) => void;
  toggleDensity: () => void;
  toggleSidebar: () => void;
  setDashboardLayout: (layout: DashboardLayout) => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      density: 'visual',
      sidebarCollapsed: false,
      dashboardLayout: [],
      setDensity: (density) => set({ density }),
      toggleDensity: () =>
        set((state) => ({ density: state.density === 'data' ? 'visual' : 'data' })),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setDashboardLayout: (dashboardLayout) => set({ dashboardLayout }),
    }),
    { name: 'gubbins:layout' },
  ),
);
