/**
 * Live settings sync — the **runtime** half (issue #382).
 *
 * Everything the pure `./settings-sync` seam cannot decide: which Zustand store each shared
 * `localStorage` key belongs to, when to publish, when to adopt, and the ordering that keeps the
 * two from fighting. Three entry points, and the order they run in is the whole design:
 *
 *  1. **Publish on change.** {@link startSettingsSync} subscribes to the participating stores, so
 *     the moment the user changes an eligible preference its row is written with the timestamp of
 *     *that* change. Nothing else can supply an honest timestamp — a value's row has to be stamped
 *     when it changed, not when a sync happened to notice it had.
 *  2. **Flush before a sync.** {@link flushSettingsSync} lets the sync screen wait for those writes,
 *     so a preference changed a moment before "Sync now" is in the snapshot that gets pushed.
 *  3. **Adopt after a merge.** {@link applySharedSettings} reads the rows the merge left behind and
 *     writes the winners into the stores. Correct by construction: the merge has just weighed this
 *     device's row against the peer's on real timestamps, so if ours won this is a no-op, and if
 *     theirs won this is exactly what Last-Write-Wins decided.
 *
 * All three are no-ops — not a single query — while settings sync is off, which is how it ships.
 */
import type { SettingRow, SettingUpsert } from '@/db/repositories/types/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { useSavedSearchesStore } from '@/features/search/useSavedSearchesStore';
import { PREFERENCES_KEY } from '@/features/backup/settings-groups';
import { parsePersistedBlob, serialisePersistedBlob } from '@/lib/persisted-state';
import {
  isSharedSettingField,
  planSettingApplies,
  planSettingPublishes,
  resolveLiveSettingsSelection,
  settingRowId,
  type LiveSettingsSelection,
  type SettingsStoreStates,
} from './settings-sync';

/**
 * The slice of a Zustand store this module needs, with the field types erased. Structural rather
 * than the stores' own types so one map can hold all three despite their unrelated state shapes;
 * {@link adaptStore} is the single place the erasure happens.
 */
interface SharedSettingsStore {
  getState(): Record<string, unknown>;
  /** Write a field patch straight into the live store. */
  setState(patch: Record<string, unknown>): void;
  /** Re-read from `localStorage`, running this store's own `migrate` + `merge` reconciliation. */
  rehydrate(): Promise<void>;
  subscribe(
    listener: (state: Record<string, unknown>, previous: Record<string, unknown>) => void,
  ): () => void;
}

/** The shape every `create()(persist(…))` store exposes, as far as this module cares. */
interface PersistedZustandStore<T extends object> {
  getState(): T;
  setState(patch: Partial<T>): void;
  subscribe(listener: (state: T, previous: T) => void): () => void;
  persist: { rehydrate(): Promise<void> | void };
}

function adaptStore<T extends object>(store: PersistedZustandStore<T>): SharedSettingsStore {
  return {
    getState: () => store.getState() as unknown as Record<string, unknown>,
    setState: (patch) => store.setState(patch as Partial<T>),
    rehydrate: async () => {
      await store.persist.rehydrate();
    },
    subscribe: (listener) =>
      store.subscribe((state, previous) =>
        listener(state as unknown as Record<string, unknown>, previous as unknown as Record<string, unknown>),
      ),
  };
}

/**
 * `localStorage` key → the store that owns it.
 *
 * The eligibility answer lives in the settings-group registry, not here; this is only the wiring
 * from a key to the store holding its state. A drift test pins that the two agree, so marking a
 * group live-syncable without teaching this map about its store fails the build rather than
 * silently publishing nothing.
 */
export const SHARED_SETTINGS_STORES: Readonly<Record<string, SharedSettingsStore>> = {
  [PREFERENCES_KEY]: adaptStore(usePreferencesStore),
  'gubbins:layout': adaptStore(useLayoutStore),
  'gubbins:saved-searches': adaptStore(useSavedSearchesStore),
};

/** The database operations this module needs, so tests can drive it without a driver. */
export interface SettingsSyncPort {
  list(): Promise<readonly SettingRow[]>;
  publish(upserts: readonly SettingUpsert[]): Promise<void>;
}

let port: SettingsSyncPort | null = null;

/**
 * Override the database port. Tests only — production resolves the repository lazily so importing
 * this module (which `main.tsx` does before the database exists) never reaches for a driver.
 */
export function setSettingsSyncPort(next: SettingsSyncPort | null): void {
  port = next;
}

async function resolvePort(): Promise<SettingsSyncPort> {
  if (port) return port;
  const { getSettingsRepository } = await import('@/db/repositories');
  return getSettingsRepository();
}

/**
 * Serialises every publish and apply. Two publishes racing could each read the table before the
 * other's write landed and both decide to write, re-stamping a row that had not changed — the
 * timestamp churn issue #161 fixed on the merge side, reached from the write side. A queue is
 * simpler than making each write conditional, and settings changes are far too rare for the
 * serialisation to be felt.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  // The chain must survive a failure, or one error would poison every later publish.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function readStoredBlob(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeStoredBlob(storageKey: string, value: string): boolean {
  try {
    localStorage.setItem(storageKey, value);
    return true;
  } catch {
    return false;
  }
}

/** The live state of every participating store, as the pure seam wants it. */
function currentStates(): SettingsStoreStates {
  const states: Record<string, Record<string, unknown>> = {};
  for (const [key, store] of Object.entries(SHARED_SETTINGS_STORES)) {
    states[key] = store.getState();
  }
  return states;
}

/** The groups this device currently shares, both gates applied. */
function currentSelection(): LiveSettingsSelection {
  const { settingsSyncEnabled, settingsSyncGroups } = usePreferencesStore.getState();
  return resolveLiveSettingsSelection(settingsSyncEnabled, settingsSyncGroups);
}

function isSharing(selection: LiveSettingsSelection): boolean {
  return Object.keys(selection).length > 0;
}

/**
 * Publish this device's eligible preferences to the shared noticeboard, returning how many rows
 * were written.
 *
 * `limitTo` (row ids) is how a single change publishes only itself, and it matters for correctness
 * rather than cost: a field can differ from its row because a *peer* changed it and this device has
 * not adopted it yet, and publishing that one would overwrite a newer value with an older one.
 * Omitting `limitTo` deliberately does exactly that for every eligible field — it is the "turning
 * sharing on publishes what this device currently has" step, and nothing else should omit it.
 */
export function publishSharedSettings(limitTo?: readonly string[]): Promise<number> {
  return enqueue(async () => {
    const selection = currentSelection();
    if (!isSharing(selection)) return 0;
    const settings = await resolvePort();
    const upserts = planSettingPublishes(currentStates(), selection, await settings.list(), limitTo);
    if (upserts.length > 0) await settings.publish(upserts);
    return upserts.length;
  });
}

/**
 * Write one store's adopted values in, through the same path a restored backup takes: merge them
 * into the stored blob and re-hydrate, so the store's own `migrate` and `merge` reconcile them.
 *
 * That indirection is the point. A peer may be running a newer build and send a value this one has
 * no arm for — a layout density it doesn't know — and re-hydrating runs the `normalise*` helpers
 * that already exist to reject exactly that, rather than duplicating ~70 range rules here. Writing
 * the store directly is only the fallback for having no readable blob to merge into (a store that
 * has never saved, or `localStorage` unavailable), where there is nothing to reconcile against.
 */
async function adoptInto(storeKey: string, patch: Record<string, unknown>): Promise<void> {
  const store = SHARED_SETTINGS_STORES[storeKey];
  if (!store) return;

  const raw = readStoredBlob(storeKey);
  const blob = raw === null ? null : parsePersistedBlob(raw);
  if (blob && writeStoredBlob(storeKey, serialisePersistedBlob(blob, { ...blob.state, ...patch }))) {
    await store.rehydrate();
    return;
  }
  store.setState(patch);
}

/**
 * Adopt the shared noticeboard's values into this device's stores. Call it after a sync merge; it
 * returns how many preferences changed, for the caller's status line.
 *
 * Nothing suppresses the store subscription while this runs, deliberately: an adopted value already
 * equals its row, so the publish it triggers finds nothing to write. Suppressing it would instead
 * open a window in which a preference the user changed *during* the adopt was silently dropped.
 */
export function applySharedSettings(): Promise<number> {
  return enqueue(async () => {
    const selection = currentSelection();
    if (!isSharing(selection)) return 0;
    const settings = await resolvePort();
    const plan = planSettingApplies(await settings.list(), currentStates(), selection);

    if (plan.rejected.length > 0) {
      // Names only, never values: this goes to the console, and a preference's value can be the
      // user's own letterhead text. A dropped row costs that one preference and nothing else.
      console.warn(
        `[gubbins] ignored ${plan.rejected.length} shared setting(s) that did not match this build's shape:`,
        plan.rejected.join(', '),
      );
    }

    let applied = 0;
    for (const [storeKey, patch] of Object.entries(plan.patches)) {
      await adoptInto(storeKey, patch);
      applied += Object.keys(patch).length;
    }
    return applied;
  });
}

/**
 * Wait for every queued publish to reach the database. The sync screen awaits this before reading
 * the local snapshot, so a preference changed a moment earlier travels in *this* sync rather than
 * the next one.
 */
export function flushSettingsSync(): Promise<void> {
  return enqueue(async () => undefined);
}

function reportPublishFailure(error: unknown): void {
  // A failed publish is not worth interrupting the user for: the preference is already saved
  // locally, and the next change (or the next time sharing is switched on) republishes it.
  console.error('[gubbins] could not publish a shared setting', error);
}

/** The device-local preferences that decide *what* is shared rather than being shared themselves. */
const SELECTION_FIELDS = ['settingsSyncEnabled', 'settingsSyncGroups'];

/**
 * Watch the participating stores and publish eligible changes. Call once at boot; returns the
 * teardown for symmetry with the other `start*` installers, though nothing unsubscribes in
 * production.
 */
export function startSettingsSync(): () => void {
  const unsubscribes = Object.entries(SHARED_SETTINGS_STORES).map(([storeKey, store]) =>
    store.subscribe((state, previous) => {
      const selection = currentSelection();
      const changed: string[] = [];
      let selectionChanged = false;

      for (const [field, value] of Object.entries(state)) {
        if (Object.is(value, previous[field])) continue;
        // The opt-in itself is device-local and never publishes, but *changing* it is what should:
        // ticking a group has to send that group's current values, or switching sharing on would
        // appear to do nothing until the user next edited something.
        if (storeKey === PREFERENCES_KEY && SELECTION_FIELDS.includes(field)) {
          selectionChanged = true;
          continue;
        }
        // Filtered here as well as inside the plan, so a change to something unshared — a bridge
        // address, a dismissed prompt, a group the user unticked — costs no database read at all.
        if (isSharedSettingField(storeKey, field, selection)) changed.push(settingRowId(storeKey, field));
      }

      if (selectionChanged) {
        publishSharedSettings().catch(reportPublishFailure);
      } else if (changed.length > 0) {
        publishSharedSettings(changed).catch(reportPublishFailure);
      }
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
