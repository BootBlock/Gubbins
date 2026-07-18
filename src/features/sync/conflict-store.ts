/**
 * useSyncConflictsStore — device-local store of unresolved sync collisions (issue #72).
 *
 * When a sync overwrites (or deletes) a local edit the user made since their last sync, the
 * reconcile engine records a {@link SyncConflict}. Those records are device-local by nature —
 * they describe *this* device's lost work — so they live here in a `localStorage`-persisted
 * Zustand store, mirroring `useDismissedAlertsStore` / `useNotifiedRemindersStore`: no DB
 * migration, no synced table. The Sync screen reads the list to badge and review them; the
 * user then keeps the current (won) version by dismissing, or restores their discarded
 * version via {@link restoreConflictVersion}.
 *
 * Conflicts accumulate across syncs until reviewed, de-duplicated by their deterministic id
 * so re-detecting the same discarded version never piles up.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';
import type { SyncConflict } from './types';

interface SyncConflictsStore {
  /** Unresolved collisions awaiting review, newest first. */
  readonly conflicts: readonly SyncConflict[];
  /** Merge freshly-detected conflicts in (de-duplicated by id); newest first. */
  add: (incoming: readonly SyncConflict[]) => void;
  /** Drop one conflict by id — after the user keeps the current version or restores theirs. */
  resolve: (id: string) => void;
  /** Clear every unresolved conflict (e.g. a "dismiss all" action). */
  clear: () => void;
}

/** Persisted shape — a plain array of the records, JSON-safe as-is. */
interface PersistedState {
  readonly conflicts: SyncConflict[];
}

export const useSyncConflictsStore = create<SyncConflictsStore>()(
  persist(
    (set) => ({
      conflicts: [],

      add: (incoming) =>
        set((state) => {
          if (incoming.length === 0) return state;
          const byId = new Map<string, SyncConflict>();
          // Newest first: this sync's conflicts ahead of the existing backlog. A re-detected id
          // is identical (deterministic id + captured versions), so either copy is equivalent;
          // the first-seen (incoming) is kept and its duplicate in the backlog dropped.
          for (const c of [...incoming, ...state.conflicts]) {
            if (!byId.has(c.id)) byId.set(c.id, c);
          }
          return { conflicts: [...byId.values()] };
        }),

      resolve: (id) => set((state) => ({ conflicts: state.conflicts.filter((c) => c.id !== id) })),

      clear: () => set({ conflicts: [] }),
    }),
    {
      name: 'gubbins:sync-conflicts',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
      partialize: (state): PersistedState => ({ conflicts: [...state.conflicts] }),
      merge: (persisted, current) => {
        const p = persisted as Partial<PersistedState>;
        return {
          ...current,
          conflicts: Array.isArray(p.conflicts) ? p.conflicts : [],
        };
      },
    },
  ),
);
