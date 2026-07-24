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
 * so re-detecting the same discarded version never piles up. Because each record carries two
 * full row snapshots against a shared `localStorage` budget, the backlog is bounded on merge
 * by age and count (see {@link mergeConflicts}) so it can never grow without limit (#373).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';
import { mergeConflicts } from './conflict-store-ops';
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
          // Dedupe (newest first), drop aged-out entries, and cap the backlog — the maths
          // lives in the pure seam; the store just supplies the wall clock.
          return { conflicts: mergeConflicts(state.conflicts, incoming, Date.now()) };
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
        const stored = Array.isArray(p.conflicts) ? p.conflicts : [];
        return {
          ...current,
          // Bound the rehydrated backlog too (age + cap), so an already-oversized store from
          // before this cap existed is trimmed on load — freeing quota without waiting for a
          // sync (#373).
          conflicts: mergeConflicts(stored, [], Date.now()),
        };
      },
    },
  ),
);
