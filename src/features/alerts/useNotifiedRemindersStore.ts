/**
 * useNotifiedRemindersStore — device-local Zustand store of alert ids we have already fired
 * an OS reminder for (G3).
 *
 * Notifications are once-per-condition: without this set, every render / refetch would re-buzz
 * the same reminders. The set is device-local (no DB migration, no synced table), persisted to
 * `localStorage` like `useDismissedAlertsStore`. The pure `planReminders` seam reconciles it
 * against the live alert feed each pass — a resolved condition drops out (so a recurrence
 * notifies again) and the set stays bounded — then hands back the reconciled set to `replace`.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface NotifiedRemindersStore {
  /** Set of alert ids already notified, persisted across page loads. */
  readonly notifiedIds: ReadonlySet<string>;
  /** Replace the whole set with the reconciled ids returned by `planReminders`. */
  replace: (ids: readonly string[]) => void;
  /** Clear all — e.g. when the user turns reminders off, so re-enabling notifies afresh. */
  clear: () => void;
}

/** Persisted shape — a `Set` is not JSON-serialisable, so store an array at the boundary. */
interface PersistedState {
  readonly notifiedIds: string[];
}

export const useNotifiedRemindersStore = create<NotifiedRemindersStore>()(
  persist(
    (set) => ({
      notifiedIds: new Set<string>(),
      replace: (ids) => set({ notifiedIds: new Set(ids) }),
      clear: () => set({ notifiedIds: new Set<string>() }),
    }),
    {
      name: 'gubbins:notified-reminders',
      partialize: (state): PersistedState => ({ notifiedIds: [...state.notifiedIds] }),
      merge: (persisted, current) => {
        const p = persisted as Partial<PersistedState>;
        return {
          ...current,
          notifiedIds: new Set<string>(Array.isArray(p.notifiedIds) ? p.notifiedIds : []),
        };
      },
    },
  ),
);
