import { create } from 'zustand';

/**
 * A one-shot "intent" handed to the Inventory screen from elsewhere in the app (the
 * dashboard command palette, the dashboard hero quick-actions, and the dashboard widget
 * quick-links). The inventory detail view and its Add/Scan dialogs are local component
 * state with no deep-linkable route, so rather than re-architect them we hand over a small
 * intent here: the Inventory screen consumes it (whether it is mounting fresh or already
 * on screen) and then clears it.
 *
 * - `pendingSearch` — seed the quick-search box with this query (jump-to-item).
 * - `pendingIntent` — open the Add-item dialog or the Scanner on arrival.
 * - `pendingLocationId` — pre-select this location in the sidebar (e.g. a widget quick-link
 *   that should land scoped to one location, such as the system In-Transit location).
 * - `pendingOpenItemId` — open one item's detail card directly on arrival, so a deep link
 *   (e.g. a Reports data-hygiene row) lands the user *on* the item rather than leaving them to
 *   hunt for it in the list. Usually paired with `pendingSearch` so the item is also in view
 *   behind the dialog once it is closed.
 */
type InventoryIntent = 'add' | 'scan' | 'import';

interface InventoryEntryStore {
  readonly pendingSearch: string | null;
  readonly pendingIntent: InventoryIntent | null;
  readonly pendingLocationId: string | null;
  readonly pendingOpenItemId: string | null;
  requestSearch: (query: string) => void;
  requestIntent: (intent: InventoryIntent) => void;
  requestLocation: (locationId: string) => void;
  requestOpenItem: (itemId: string) => void;
  clearSearch: () => void;
  clearIntent: () => void;
  clearLocation: () => void;
  clearOpenItem: () => void;
}

export const useInventoryEntry = create<InventoryEntryStore>((set) => ({
  pendingSearch: null,
  pendingIntent: null,
  pendingLocationId: null,
  pendingOpenItemId: null,
  requestSearch: (pendingSearch) => set({ pendingSearch }),
  requestIntent: (pendingIntent) => set({ pendingIntent }),
  requestLocation: (pendingLocationId) => set({ pendingLocationId }),
  requestOpenItem: (pendingOpenItemId) => set({ pendingOpenItemId }),
  clearSearch: () => set({ pendingSearch: null }),
  clearIntent: () => set({ pendingIntent: null }),
  clearLocation: () => set({ pendingLocationId: null }),
  clearOpenItem: () => set({ pendingOpenItemId: null }),
}));
