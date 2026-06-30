import { create } from 'zustand';

/**
 * Open/closed state for the global command palette (Cmd/Ctrl-K item search). A tiny
 * store so any surface can open it — the dashboard hero's "Search" trigger, and the
 * global keyboard shortcut wired in {@link CommandPalette} itself.
 */
interface CommandPaletteStore {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
