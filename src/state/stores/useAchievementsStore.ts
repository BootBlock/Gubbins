/**
 * useAchievementsStore — device-local record of which achievements have been earned (issue #412).
 *
 * Gubbins celebrated a couple of milestones with the F4 success burst but kept no record of them,
 * so the firework was the whole of it. This store is that record: an id from
 * {@link ACHIEVEMENTS} maps to *when* it was earned, and the Achievements screen renders the map.
 *
 * The stored instant is nullable, and the difference matters. A `number` is the moment the app
 * actually watched the achievement being earned. `null` means "earned, but the date is not known"
 * — the honest answer for an achievement backfilled from state that was already true when the app
 * first looked (an inventory that already held two hundred items long before this screen existed),
 * and for the one milestone the previous store recorded as a bare boolean.
 *
 * It is per-device, never synced — the same posture as theme / modules / layout — and needs no
 * database schema or migration. Its `localStorage` key is still `gubbins:milestones`: the key
 * predates the Achievements screen, and renaming it would silently discard what every existing
 * install has already earned. The persisted *shape* is migrated (v1 → v2) rather than the name.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isPlainObject, normaliseNullableInteger } from '@/lib/persisted-state';
import { ACHIEVEMENT_IDS, type AchievementId } from '@/features/achievements/registry';

/** When each earned achievement was earned, or `null` where the instant isn't known. */
export type AchievementUnlocks = Readonly<Partial<Record<AchievementId, number | null>>>;

interface AchievementsStore {
  readonly unlocked: AchievementUnlocks;
  /**
   * Record `id` as earned at `at` (epoch ms, or `null` when the instant isn't known).
   *
   * First write wins: an achievement already recorded is left exactly as it was, so a later
   * backfill can never overwrite a real instant with `null`, and re-awarding is a no-op.
   */
  unlock: (id: AchievementId, at: number | null) => void;
}

/**
 * Reconcile a rehydrated `unlocked` map: keep only ids that still exist in the registry, and
 * coerce each value to `number | null`. A retired id, or a value hand-edited into nonsense, would
 * otherwise reach the screen and be counted towards a total it is no longer part of.
 *
 * @internal Exported for unit tests.
 */
export function normaliseUnlocks(value: unknown): AchievementUnlocks {
  if (!isPlainObject(value)) return {};
  const out: Partial<Record<AchievementId, number | null>> = {};
  for (const id of ACHIEVEMENT_IDS) {
    if (!(id in value)) continue;
    out[id] = normaliseNullableInteger(value[id]);
  }
  return out;
}

/**
 * `migrate` for the v1 → v2 shape change: v1 recorded exactly one milestone, as the boolean
 * `firstItemCelebrated`. That boolean says the first-item burst played but not when, so it adopts
 * as the `first-item` achievement with a `null` instant — earned, date unknown.
 *
 * @internal Exported for unit tests.
 */
export function migrateAchievements(persistedState: unknown): { unlocked: AchievementUnlocks } {
  if (isPlainObject(persistedState) && persistedState.firstItemCelebrated === true) {
    return { unlocked: { 'first-item': null } };
  }
  return { unlocked: {} };
}

export const useAchievementsStore = create<AchievementsStore>()(
  persist(
    (set, get) => ({
      unlocked: {},
      unlock: (id, at) => {
        if (get().unlocked[id] !== undefined) return;
        set((s) => ({ unlocked: { ...s.unlocked, [id]: at } }));
      },
    }),
    {
      name: 'gubbins:milestones',
      // v2 = the achievement map; v1 was the single `firstItemCelebrated` boolean.
      version: 2,
      // The cast is the usual `persist` shape fiction: `migrate` is typed to return the whole
      // store, but only the persisted slice is ever migrated — `merge` below puts the actions
      // back from the live store.
      migrate: (persisted) => migrateAchievements(persisted) as AchievementsStore,
      merge: (persisted, current) => ({
        ...current,
        unlocked: normaliseUnlocks(isPlainObject(persisted) ? persisted.unlocked : undefined),
      }),
    },
  ),
);
