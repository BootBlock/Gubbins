/**
 * Resetting the **live** stores behind a local-scope erase (issue #381).
 *
 * `eraseTargets` removes a target's `localStorage` keys, but a Zustand `persist` store keeps its
 * state in memory: nothing tells the running store that its key just went away. That left a
 * selective erase looking like it had failed, and — worse — able to undo itself. The store's next
 * mutation writes its *whole* retained state back under the same key, so erasing "App preferences"
 * and then changing any single preference restored the entire blob the user had just erased.
 *
 * Every erasable key therefore declares how to reset its live copy here. The resets use Zustand's
 * `getInitialState()`, so a store returns to exactly the defaults its initializer produced — no
 * hand-maintained duplicate of each store's default state to drift out of sync.
 *
 * Two details worth knowing:
 *
 *  - **The reset re-persists, so the key is removed again afterwards.** `setState` fires the
 *    persist middleware, which writes the fresh defaults straight back under the key the erase
 *    just deleted. {@link resetLocalStores} drops that write, leaving both memory and storage
 *    clean — otherwise the Danger Zone's affected-count badge would still read 1 after erasing.
 *  - **Not every key has a live copy.** Some values are read from storage on demand (the OAuth
 *    crumbs) or only at component mount (the emoji picker's panel size), so removing the key is
 *    already sufficient. Those declare `null` rather than being absent, so "nothing to reset" is
 *    a recorded decision — `local-store-resets.test.ts` checks this record against the shared key
 *    registry and fails when an erasable key appears in neither form.
 */
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useMilestonesStore } from '@/state/stores/useMilestonesStore';
import { useSavedSearchesStore } from '@/features/search/useSavedSearchesStore';
import { useDismissedAlertsStore } from '@/features/alerts/useDismissedAlertsStore';
import { useNotifiedRemindersStore } from '@/features/alerts/useNotifiedRemindersStore';
import { useSyncConflictsStore } from '@/features/sync/conflict-store';
import { useExportStore } from '@/features/export/useExportStore';
import { usePwaUpdateSnoozeStore } from '@/components/foundry/usePwaUpdateSnoozeStore';
import { useLocationExpansionStore } from '@/features/inventory/useLocationExpansionStore';
import { useAuditSessionStore } from '@/features/lifecycle/useAuditSessionStore';
import { EMOJI_PICKER_SIZE_KEY } from '@/lib/storage-keys';

/** The slice of a Zustand store API this module needs — narrow enough to fake in a test. */
interface ResettableStore<T> {
  getInitialState: () => T;
  setState: (state: T, replace: true) => void;
}

/**
 * Restore a store to the exact state its initializer produced. `replace: true` is deliberate: a
 * merge would leave keys the user added (a saved search, a dismissed alert id) in place, which is
 * the opposite of an erase.
 *
 * Exported so the tests can drive the same reset against a stand-in store rather than asserting
 * against whichever real store happens to be convenient.
 */
export function toDefaults<T>(store: ResettableStore<T>): () => void {
  return () => store.setState(store.getInitialState(), true);
}

/**
 * How to reset the live copy of each erasable key, or `null` where no live copy exists. Keyed by
 * the same `localStorage` key the erase catalog removes.
 */
export const LOCAL_STORE_RESETS: Readonly<Record<string, (() => void) | null>> = {
  'gubbins:preferences': toDefaults(usePreferencesStore),
  'gubbins:layout': toDefaults(useLayoutStore),
  'gubbins:saved-searches': toDefaults(useSavedSearchesStore),
  'gubbins:modules': toDefaults(useModulesStore),
  'gubbins:dismissed-alerts': toDefaults(useDismissedAlertsStore),
  'gubbins:notified-reminders': toDefaults(useNotifiedRemindersStore),
  'gubbins:auth': toDefaults(useAuthStore),
  'gubbins:sync-conflicts': toDefaults(useSyncConflictsStore),
  'gubbins:export': toDefaults(useExportStore),
  'gubbins:pwa-update-snooze': toDefaults(usePwaUpdateSnoozeStore),
  'gubbins:location-expansion': toDefaults(useLocationExpansionStore),
  'gubbins:audit-session': toDefaults(useAuditSessionStore),
  'gubbins:milestones': toDefaults(useMilestonesStore),

  // Read from storage on demand, so the erase already took effect — there is no retained copy to
  // reset, and no later write that could resurrect the removed value.
  'gubbins:google-drive-token': null,
  'gubbins:google-oauth-pending': null,
  'gubbins:google-oauth-error': null,

  // Read once when the picker mounts; the next open picks up the default size.
  [EMOJI_PICKER_SIZE_KEY]: null,
};

/** The map's shape, so a caller (the tests) can supply a stand-in instead of the real stores. */
export type StoreResets = Readonly<Record<string, (() => void) | null>>;

/**
 * Reset the live stores behind the given just-erased keys, then drop the defaults the resets
 * persisted so storage stays clean. Safe to call with keys that have no live copy, and with a
 * store whose reset throws — one failing store must not stop the rest, exactly like the
 * best-effort teardown in `clearLocalAppState`.
 *
 * `resets` and `storage` are injectable so a test can drive the real sequence against a stand-in
 * store rather than mutating the production map.
 */
export function resetLocalStores(
  keys: readonly string[],
  storage: Storage = localStorage,
  resets: StoreResets = LOCAL_STORE_RESETS,
): void {
  for (const key of keys) {
    const reset = resets[key];
    if (!reset) continue;
    try {
      reset();
      storage.removeItem(key);
    } catch {
      // A store that refuses to reset (or storage that refuses the write) must not block the
      // remaining keys — the erase itself has already committed.
    }
  }
}
