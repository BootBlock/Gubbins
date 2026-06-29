/**
 * useSavedSearchesStore — Tier-2 store for named hybrid text searches (spec §2.1, §3).
 *
 * A small, domain-specific Zustand store (no god store, §2.1) persisting the user's
 * saved search queries to localStorage so they survive reloads — device-local, so no
 * DB migration. The add/dedupe/cap logic lives in the pure `saved-searches.ts` seam;
 * this store is thin glue over it.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { addSavedSearch, removeSavedSearch, type SavedSearch } from './saved-searches';

interface SavedSearchesStore {
  readonly searches: readonly SavedSearch[];
  /** Save (or update by name) the current query text under a label. */
  save: (name: string, query: string) => void;
  /** Forget a saved search by id. */
  remove: (id: string) => void;
}

export const useSavedSearchesStore = create<SavedSearchesStore>()(
  persist(
    (set) => ({
      searches: [],
      save: (name, query) =>
        set((state) => ({ searches: addSavedSearch(state.searches, name, query) })),
      remove: (id) => set((state) => ({ searches: removeSavedSearch(state.searches, id) })),
    }),
    { name: 'gubbins:saved-searches' },
  ),
);
