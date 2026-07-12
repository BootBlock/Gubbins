/**
 * useBackdropStore — ephemeral (non-persisted) flag: is a screen currently showing its own
 * full-viewport decorative backdrop that the app-wide weather layer should yield to?
 *
 * The About screen's {@link import('@/features/about/Starfield').Starfield} owns the full backdrop
 * while it is open, and the drifting snow/rain of {@link
 * import('@/components/background/BackgroundEffects').BackgroundEffects} interferes with it, so the
 * starfield raises this flag on mount and clears it on unmount; the weather layer reads it and
 * renders nothing while a backdrop is active. Device-local, session-only — never persisted.
 */
import { create } from 'zustand';

interface BackdropStore {
  /** True while a screen is showing its own full-viewport decorative backdrop. */
  readonly backdropActive: boolean;
  setBackdropActive: (active: boolean) => void;
}

export const useBackdropStore = create<BackdropStore>((set) => ({
  backdropActive: false,
  setBackdropActive: (backdropActive) => set({ backdropActive }),
}));
