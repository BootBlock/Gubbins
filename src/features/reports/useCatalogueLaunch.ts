/**
 * useCatalogueLaunch — a one-shot hand-off of a pre-chosen {@link CatalogueScope} from
 * elsewhere in the app (the inventory multi-select "Print catalogue" action, a location's row
 * actions, …) to the Catalogue screen it navigates to.
 *
 * The scope — especially an ad-hoc selection of many item ids — is awkward and lossy to carry
 * through the URL, so a launcher stashes it here and navigates to `/catalogue`; the screen
 * reads it once on mount and clears it. A plain module-level store (no persistence): a pending
 * launch should never survive a reload. When the screen is opened directly (e.g. from Reports)
 * there is no pending scope and it falls back to its own scope pickers.
 */
import { create } from 'zustand';
import type { CatalogueScope } from './parts-catalogue';

interface CatalogueLaunchState {
  /** The scope a launcher wants the Catalogue screen to open with, or null for none pending. */
  readonly pendingScope: CatalogueScope | null;
  /** Stash a scope, then navigate to `/catalogue`. */
  readonly launch: (scope: CatalogueScope) => void;
  /** Read-and-clear the pending scope (the screen calls this once on mount). */
  readonly consume: () => CatalogueScope | null;
}

export const useCatalogueLaunch = create<CatalogueLaunchState>((set, get) => ({
  pendingScope: null,
  launch: (scope) => set({ pendingScope: scope }),
  consume: () => {
    const scope = get().pendingScope;
    if (scope !== null) set({ pendingScope: null });
    return scope;
  },
}));
