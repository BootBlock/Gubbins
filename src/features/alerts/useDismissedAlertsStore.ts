/**
 * useDismissedAlertsStore — device-local Zustand store for dismissed alert ids
 * (Phase 68, spec §3 alert centre).
 *
 * Dismissals are device-local: no DB migration, no synced table. The ids are
 * persisted to `localStorage` via Zustand `persist`, mirroring the pattern used by
 * `useSavedSearchesStore` (search feature). An alert with a new id (e.g. because
 * its warranty date changed) will reappear automatically — dismissed ids that no
 * longer match any current alert are simply ignored by `applyDismissals`.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface DismissedAlertsStore {
  /** Set of dismissed alert ids, persisted across page loads. */
  readonly dismissedIds: ReadonlySet<string>;
  /** Dismiss (hide) an alert by its id. Idempotent. */
  dismiss: (id: string) => void;
  /** Restore a previously dismissed alert by its id. */
  restore: (id: string) => void;
  /** Clear all dismissals (e.g. "Show all" action). */
  clearAll: () => void;
}

/**
 * Zustand's `persist` middleware serialises the state to JSON. `Set` is not
 * natively JSON-serialisable, so we store the dismissed ids as a plain string
 * array and convert to/from a `Set` at the boundary.
 */
interface PersistedState {
  readonly dismissedIds: string[];
}

export const useDismissedAlertsStore = create<DismissedAlertsStore>()(
  persist(
    (set) => ({
      dismissedIds: new Set<string>(),

      dismiss: (id) =>
        set((state) => ({
          dismissedIds: new Set([...state.dismissedIds, id]),
        })),

      restore: (id) =>
        set((state) => {
          const next = new Set(state.dismissedIds);
          next.delete(id);
          return { dismissedIds: next };
        }),

      clearAll: () => set({ dismissedIds: new Set<string>() }),
    }),
    {
      name: 'gubbins:dismissed-alerts',
      // Serialise the Set as an array for JSON storage.
      partialize: (state): PersistedState => ({
        dismissedIds: [...state.dismissedIds],
      }),
      // Rehydrate the array back into a Set.
      merge: (persisted, current) => {
        const p = persisted as Partial<PersistedState>;
        return {
          ...current,
          dismissedIds: new Set<string>(Array.isArray(p.dismissedIds) ? p.dismissedIds : []),
        };
      },
    },
  ),
);
