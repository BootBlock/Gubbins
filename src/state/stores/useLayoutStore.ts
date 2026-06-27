/**
 * useLayoutStore — Tier-2 global UI layout state (spec §2.1, §3 "Adaptive Density").
 *
 * Owns the Data-Heavy ↔ Visual-Heavy density toggle and sidebar collapse state,
 * persisted to localStorage so the user's chosen layout survives reloads. Kept
 * deliberately small and domain-specific — no god store (§2.1).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * - `data` — dense, tabular layouts (the "Data-Heavy" view).
 * - `visual` — large image cards, ample whitespace (the "Visual-Heavy" view).
 */
export type LayoutDensity = 'data' | 'visual';

interface LayoutStore {
  readonly density: LayoutDensity;
  readonly sidebarCollapsed: boolean;
  setDensity: (density: LayoutDensity) => void;
  toggleDensity: () => void;
  toggleSidebar: () => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      density: 'visual',
      sidebarCollapsed: false,
      setDensity: (density) => set({ density }),
      toggleDensity: () =>
        set((state) => ({ density: state.density === 'data' ? 'visual' : 'data' })),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    { name: 'gubbins:layout' },
  ),
);
