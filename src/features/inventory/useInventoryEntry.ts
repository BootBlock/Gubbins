import { create } from 'zustand';

/**
 * A one-shot "intent" handed to the Inventory screen from elsewhere in the app (the dashboard
 * hero quick-actions, the Getting-started panel, a global hotkey, a Reports data-hygiene row).
 *
 * What remains here is deliberately narrow: the screen's *view* — which location it is scoped to,
 * what is in the quick-search box, which chips and facets are on, which page — is expressed in the
 * `/inventory` URL (issue #574), so anywhere wanting to land the user on a particular list simply
 * links to it. Only the two things a URL should *not* carry are handed over here:
 *
 * - `pendingIntent` — open the Add-item dialog, the Scanner or the Import wizard on arrival. An
 *   action to perform once, not a view to restore: putting it in the URL would reopen the dialog
 *   on every reload and on every Back press onto that entry.
 * - `pendingOpenItemId` — open one item's detail card directly on arrival, so a deep link (e.g. a
 *   Reports data-hygiene row) lands the user *on* the item rather than leaving them to hunt for
 *   it. Also a dialog, and dialogs already claim a history entry of their own
 *   (`foundry/dialog-history.ts`), so a second one in the URL would take two Back presses to
 *   undo a single open. Callers pair it with `?q=<name>` so the item is in the list behind the
 *   dialog once it is closed.
 *
 * The Inventory screen consumes an intent (whether it is mounting fresh or already on screen) and
 * then clears it.
 */
type InventoryIntent = 'add' | 'scan' | 'import';

interface InventoryEntryStore {
  readonly pendingIntent: InventoryIntent | null;
  readonly pendingOpenItemId: string | null;
  requestIntent: (intent: InventoryIntent) => void;
  requestOpenItem: (itemId: string) => void;
  clearIntent: () => void;
  clearOpenItem: () => void;
}

export const useInventoryEntry = create<InventoryEntryStore>((set) => ({
  pendingIntent: null,
  pendingOpenItemId: null,
  requestIntent: (pendingIntent) => set({ pendingIntent }),
  requestOpenItem: (pendingOpenItemId) => set({ pendingOpenItemId }),
  clearIntent: () => set({ pendingIntent: null }),
  clearOpenItem: () => set({ pendingOpenItemId: null }),
}));
