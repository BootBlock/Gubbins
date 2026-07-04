/**
 * useDashboardCustomise — the landing hub's single "Customise" edit mode.
 *
 * One transient, session-only flag shared by the two reorder surfaces on the dashboard:
 * the {@link DashboardNav} tile grid and the {@link DashboardGrid} widget board. A single
 * "Customise" button (in DashboardNav, near the top) toggles it, so **both** boards enter and
 * leave edit mode together — there is no second button. Deliberately **not** persisted: edit
 * mode is a momentary "I'm rearranging" state, not a preference, and it's reset when the user
 * leaves the dashboard (see DashboardScreen). The actual layouts it edits *are* persisted, in
 * `useLayoutStore` (widget board) and the nav order store.
 */
import { create } from 'zustand';

interface DashboardCustomiseStore {
  /** Whether the hub is in "Customise" (edit) mode — both boards read this. */
  readonly editing: boolean;
  setEditing: (editing: boolean) => void;
  toggle: () => void;
}

export const useDashboardCustomise = create<DashboardCustomiseStore>((set) => ({
  editing: false,
  setEditing: (editing) => set({ editing }),
  toggle: () => set((state) => ({ editing: !state.editing })),
}));
