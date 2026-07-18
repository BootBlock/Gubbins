/**
 * Open/closed state for the keyboard-shortcuts cheat sheet (issue #127).
 *
 * A store rather than local state in the layout, because the overlay is opened from three
 * unrelated places — the `?` hotkey, the command palette's screen list, and the Settings tab's
 * "show the cheat sheet" link — and none of them are ancestors of the other.
 */
import { create } from 'zustand';

interface ShortcutsOverlayStore {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useShortcutsOverlay = create<ShortcutsOverlayStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
