import { create } from 'zustand';

/**
 * A one-shot "intent" handed to the Inventory screen from elsewhere in the app (the
 * dashboard command palette and the dashboard hero quick-actions). The inventory detail
 * view and its Add/Scan dialogs are local component state with no deep-linkable route, so
 * rather than re-architect them we hand over a small intent here: the Inventory screen
 * consumes it (whether it is mounting fresh or already on screen) and then clears it.
 *
 * - `pendingSearch` — seed the quick-search box with this query (jump-to-item).
 * - `pendingIntent` — open the Add-item dialog or the Scanner on arrival.
 */
type InventoryIntent = 'add' | 'scan';

interface InventoryEntryStore {
  readonly pendingSearch: string | null;
  readonly pendingIntent: InventoryIntent | null;
  requestSearch: (query: string) => void;
  requestIntent: (intent: InventoryIntent) => void;
  clearSearch: () => void;
  clearIntent: () => void;
}

export const useInventoryEntry = create<InventoryEntryStore>((set) => ({
  pendingSearch: null,
  pendingIntent: null,
  requestSearch: (pendingSearch) => set({ pendingSearch }),
  requestIntent: (pendingIntent) => set({ pendingIntent }),
  clearSearch: () => set({ pendingSearch: null }),
  clearIntent: () => set({ pendingIntent: null }),
}));
