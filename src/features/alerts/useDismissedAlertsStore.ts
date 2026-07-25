/**
 * useDismissedAlertsStore — device-local Zustand store for dismissed alert ids
 * (Phase 68, spec §3 alert centre).
 *
 * Dismissals are device-local: no DB migration, no synced table. The records are
 * persisted to `localStorage` via Zustand `persist`, mirroring the pattern used by
 * `useSavedSearchesStore` (search feature). An alert with a new id (e.g. because its
 * warranty date changed) will reappear automatically — records that no longer match
 * any current alert are ignored by `applyDismissals`, and eventually dropped by
 * `pruneDismissals` (issue #134) so the set stays bounded rather than accumulating a
 * dead entry for every item ever deleted.
 *
 * Each record carries a deadline, so an alert can be **snoozed** rather than only
 * silenced for good: `dismiss` hides it indefinitely, `snooze` hides it until a moment
 * in time. The rules are pure and live in `alerts.ts`; this store is just the storage.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isPlainObject, normaliseArray } from '@/lib/persisted-state';
import { nowMs } from '@/lib/clock';
import type { AlertDismissal, AlertDismissals } from './alerts';

interface DismissedAlertsStore {
  /** Dismissal records keyed by alert id, persisted across page loads. */
  readonly dismissals: AlertDismissals;
  /** Hide an alert until the user restores it. Idempotent. */
  dismiss: (id: string) => void;
  /** Hide an alert until `until` (epoch-ms), after which it returns by itself. */
  snooze: (id: string, until: number) => void;
  /** Restore a previously dismissed or snoozed alert by its id. */
  restore: (id: string) => void;
  /** Clear all dismissals (e.g. "Show all" action). */
  clearAll: () => void;
  /** Adopt the reconciled map `pruneDismissals` handed back. */
  replace: (dismissals: AlertDismissals) => void;
}

/**
 * Zustand's `persist` middleware serialises the state to JSON. `Map` is not natively
 * JSON-serialisable, so the records are stored as a plain object keyed by alert id and
 * converted to/from a `Map` at the boundary.
 */
interface PersistedState {
  readonly dismissals: Record<string, AlertDismissal>;
}

/** The shipped v0/v1 shape: a bare list of ids, every one an indefinite dismissal. */
interface PersistedV1 {
  readonly dismissedIds: string[];
}

const isString = (candidate: unknown): candidate is string => typeof candidate === 'string';

/**
 * Rebuild the map from whatever `JSON.parse` returned. A value written by a future release,
 * hand-edited in devtools or truncated by a quota error arrives here as-is, so every field is
 * checked rather than trusted: a malformed entry is dropped, not admitted as a phantom
 * dismissal hiding an alert the user can no longer see to restore.
 */
function parseDismissals(value: unknown): AlertDismissals {
  if (!isPlainObject(value)) return new Map();
  const parsed = new Map<string, AlertDismissal>();
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    const { until, at } = entry;
    if (until !== null && !(typeof until === 'number' && Number.isFinite(until))) continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    parsed.set(id, { until, at });
  }
  return parsed;
}

/** Record `id` as hidden until `until`, replacing any existing record for it. */
function withDismissal(
  dismissals: AlertDismissals,
  id: string,
  until: number | null,
): { dismissals: AlertDismissals } {
  const next = new Map(dismissals);
  next.set(id, { until, at: nowMs() });
  return { dismissals: next };
}

export const useDismissedAlertsStore = create<DismissedAlertsStore>()(
  persist(
    (set) => ({
      dismissals: new Map<string, AlertDismissal>(),

      dismiss: (id) => set((state) => withDismissal(state.dismissals, id, null)),

      snooze: (id, until) => set((state) => withDismissal(state.dismissals, id, until)),

      restore: (id) =>
        set((state) => {
          const next = new Map(state.dismissals);
          next.delete(id);
          return { dismissals: next };
        }),

      clearAll: () => set({ dismissals: new Map<string, AlertDismissal>() }),

      replace: (dismissals) => set({ dismissals: new Map(dismissals) }),
    }),
    {
      name: 'gubbins:dismissed-alerts',
      // v2 = each id carries a dismissal record (issue #134); v0/v1 stored a bare array of ids.
      version: 2,
      /**
       * Adopt the older shape rather than discarding it: zustand hydrates with `undefined` when a
       * version bump ships without a `migrate`, which here would silently un-dismiss every alert
       * the user had already dealt with. Each stored id becomes an indefinite dismissal — exactly
       * what it meant before — stamped `now`, so the staleness grace period runs from the upgrade
       * instead of instantly expiring records whose alerts are no longer in the feed.
       */
      migrate: (persisted, version): PersistedState => {
        if (version >= 2) return persisted as PersistedState;
        const ids = normaliseArray((persisted as Partial<PersistedV1> | null)?.dismissedIds, [], isString);
        const at = nowMs();
        return { dismissals: Object.fromEntries(ids.map((id) => [id, { until: null, at }])) };
      },
      // Serialise the Map as a plain object for JSON storage.
      partialize: (state): PersistedState => ({
        dismissals: Object.fromEntries(state.dismissals),
      }),
      // Rehydrate the object back into a Map, dropping anything malformed.
      merge: (persisted, current) => ({
        ...current,
        dismissals: parseDismissals((persisted as Partial<PersistedState> | null)?.dismissals),
      }),
    },
  ),
);
