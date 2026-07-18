/**
 * A one-shot "create this" intent handed to a screen by a global shortcut (issue #127).
 *
 * The Projects and Purchase-orders create dialogs are local component state with no route of
 * their own, exactly like Inventory's Add dialog — so a shortcut pressed from anywhere in the app
 * cannot open one directly. It navigates to the screen and leaves an intent here; the screen
 * consumes it on arrival (whether it is mounting fresh or already on screen) and clears it.
 *
 * This is the same handover `useInventoryEntry` already does for `add` / `scan`. It is kept
 * separate rather than folded into that store because that one is Inventory's own vocabulary
 * (search text, a location to pre-select, an item to open) and this is not Inventory's business.
 */
import { create } from 'zustand';

/** The create-flows a global shortcut can ask a screen to open on arrival. */
export type HotkeyIntent = 'new-project' | 'new-purchase-order';

interface HotkeyIntentStore {
  readonly pending: HotkeyIntent | null;
  request: (intent: HotkeyIntent) => void;
  /** Clear the intent if it is the one this screen handles; a no-op otherwise. */
  consume: (intent: HotkeyIntent) => void;
}

export const useHotkeyIntent = create<HotkeyIntentStore>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  consume: (intent) => set((state) => (state.pending === intent ? { pending: null } : state)),
}));
