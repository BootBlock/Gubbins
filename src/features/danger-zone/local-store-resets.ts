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
 *  - **Not every key has a live copy.** Some values are read from storage on demand (the Drive
 *    access token) or only at component mount (the emoji picker's panel size), so removing the key is
 *    already sufficient. Those declare `null` rather than being absent, so "nothing to reset" is
 *    a recorded decision — `local-store-resets.test.ts` checks this record against the shared key
 *    registry and fails when an erasable key appears in neither form.
 */
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useAchievementsStore } from '@/state/stores/useAchievementsStore';
import { useClockSkewStore } from '@/state/stores/useClockSkewStore';
import { useSavedSearchesStore } from '@/features/search/useSavedSearchesStore';
import { useDismissedAlertsStore } from '@/features/alerts/useDismissedAlertsStore';
import { useNotifiedRemindersStore } from '@/features/alerts/useNotifiedRemindersStore';
import { useSyncConflictsStore } from '@/features/sync/conflict-store';
import { useExportStore } from '@/features/export/useExportStore';
import { usePwaUpdateSnoozeStore } from '@/components/foundry/usePwaUpdateSnoozeStore';
import { useLocationExpansionStore } from '@/features/inventory/useLocationExpansionStore';
import { useAuditSessionStore } from '@/features/lifecycle/useAuditSessionStore';
import { useCountDraftStore } from '@/features/lifecycle/useCountDraftStore';
import { resetPreferenceFields } from '@/state/stores/usePreferencesStore';
import { eraseTargetById, type EraseTargetId } from './erase-targets';
import { EMOJI_PICKER_SIZE_KEY, LAST_ORPHAN_SWEEP_KEY, TEXTAREA_SIZES_KEY } from '@/lib/storage-keys';

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
  // Resetting also returns the derived authority and actor to their defaults, so an erase
  // leaves the app in the same state as a fresh install rather than mid-session.
  'gubbins:session': toDefaults(useSessionStore),
  'gubbins:sync-conflicts': toDefaults(useSyncConflictsStore),
  'gubbins:export': toDefaults(useExportStore),
  'gubbins:pwa-update-snooze': toDefaults(usePwaUpdateSnoozeStore),
  'gubbins:location-expansion': toDefaults(useLocationExpansionStore),
  'gubbins:audit-session': toDefaults(useAuditSessionStore),
  // The stock-take's unfinished count sheets (issue #587). A dialog left open holds its sheet in
  // React state and would save it straight back on the next keystroke, so the live store has to
  // be emptied too — otherwise the erase would appear to undo itself mid-count.
  'gubbins:count-drafts': toDefaults(useCountDraftStore),
  'gubbins:milestones': toDefaults(useAchievementsStore),
  // Resetting the store also un-corrects the evaluation clock: `startClockSkew` subscribes to
  // `skewMs`, so clearing it here pushes 0 straight through to `setClockSkewMs`. The next boot
  // re-measures and re-applies a correction if the device clock really is wrong.
  'gubbins:clock-skew': toDefaults(useClockSkewStore),

  // Read from storage on demand, so the erase already took effect — there is no retained copy to
  // reset, and no later write that could resurrect the removed value. (The two OAuth redirect
  // crumbs that used to sit here are `sessionStorage`, so no erase target removes them — see
  // their notes in `lib/storage-keys.ts`.)
  'gubbins:google-drive-token': null,

  // Read once when the picker mounts; the next open picks up the default size.
  [EMOJI_PICKER_SIZE_KEY]: null,

  // Read once when each text box mounts, for the same reason as the picker above: a box already
  // on screen keeps the height it opened at, and the next one opens at the default size.
  [TEXTAREA_SIZES_KEY]: null,

  // Read from storage on demand each time the automatic sweep is considered; there is no live
  // store, and losing the timestamp just makes the next launch sweep once (harmless).
  [LAST_ORPHAN_SWEEP_KEY]: null,
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

/**
 * Reset every live store behind a completed erase, in the one order that leaves storage clean.
 *
 * A target erases either whole keys ({@link EraseTarget.localKeys}) or individual fields of the
 * preferences blob ({@link EraseTarget.prefFields}, issue #521), and a single erase can select
 * both — "App preferences" and "Bridge access token" sit in the same Danger-Zone section.
 *
 * **The field resets must run first.** {@link resetLocalStores} finishes each key by removing it
 * again, precisely so the write its store reset provoked does not resurrect the key. A field reset
 * is another `setState` on `usePreferencesStore`, so running it *after* that removal writes
 * `gubbins:preferences` straight back — the erase reports success and the affected-count badge
 * still reads 1, which is the exact symptom issue #381's ordering exists to prevent. Run it first
 * and the key removal drops that write too.
 */
export function resetErasedLocalState(
  erased: readonly EraseTargetId[],
  storage: Storage = localStorage,
  resets: StoreResets = LOCAL_STORE_RESETS,
  resetFields: (fields: readonly string[]) => void = resetPreferenceFields,
): void {
  const targets = erased.map((id) => eraseTargetById(id)).filter((t) => t !== undefined);
  resetFields(targets.flatMap((target) => target.prefFields ?? []));
  resetLocalStores(
    targets.flatMap((target) => target.localKeys ?? []),
    storage,
    resets,
  );
}
