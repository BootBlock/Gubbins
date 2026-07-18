/**
 * useLocationExpansionStore — device-local Zustand store for the Location sidebar's
 * expanded/collapsed state (spec §4 location tree).
 *
 * The tree's expansion is device-local UI state, not synced data: no DB migration, no
 * synced table — it is persisted to `localStorage` via Zustand `persist`, mirroring
 * `useDismissedAlertsStore` / `useLayoutStore`. Only explicit user toggles are recorded
 * as **overrides**; the baseline (top-level open, deeper collapsed) is applied by the
 * reader in `useLocationSidebar` so unopened branches cost nothing to store. An id with
 * no override simply falls back to that default, so a brand-new location — or one this
 * device has never touched — behaves sensibly without an entry here.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';

interface LocationExpansionStore {
  /**
   * Per-location expansion overrides: `true` = user-expanded, `false` = user-collapsed.
   * A missing id means "no override" — the reader applies the depth-based default.
   */
  readonly overrides: Readonly<Record<string, boolean>>;
  /** Record an explicit expand (`open=true`) or collapse (`open=false`) for a location. */
  setExpanded: (id: string, open: boolean) => void;
  /**
   * Drop overrides for ids no longer present, keeping `localStorage` bounded as
   * locations are deleted over the app's lifetime. A no-op (same reference) when
   * nothing is stale, so it is safe to call from an effect on every list change.
   */
  prune: (validIds: ReadonlySet<string>) => void;
  /** Clear every override (baseline defaults resume). Primarily for tests. */
  reset: () => void;
}

export const useLocationExpansionStore = create<LocationExpansionStore>()(
  persist(
    (set) => ({
      overrides: {},

      setExpanded: (id, open) => set((state) => ({ overrides: { ...state.overrides, [id]: open } })),

      prune: (validIds) =>
        set((state) => {
          const entries = Object.entries(state.overrides);
          const kept = entries.filter(([id]) => validIds.has(id));
          // Return the same reference when nothing was dropped, so the store doesn't
          // notify subscribers (and trigger a re-render) on an idempotent prune.
          if (kept.length === entries.length) return state;
          return { overrides: Object.fromEntries(kept) };
        }),

      reset: () => set({ overrides: {} }),
    }),
    {
      name: 'gubbins:location-expansion',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
    },
  ),
);
