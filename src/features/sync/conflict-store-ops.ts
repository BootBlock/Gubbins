/**
 * Pure list maths behind {@link useSyncConflictsStore} (issue #373).
 *
 * The store is device-local and persisted to `localStorage`, sharing a roughly 5 MB
 * origin-wide budget with `gubbins:preferences` (which can itself hold a `data:` URL logo).
 * Each {@link SyncConflict} carries *two* full database rows (the discarded local version and
 * the winning remote one), so an unbounded backlog of unreviewed conflicts is plausibly
 * megabytes — and because the quota is shared, the symptom of overflow is the *next*
 * preferences write silently throwing, not anything on the Sync screen.
 *
 * So the merge is bounded two ways, matching the house pattern
 * (`MAX_SAVED_SEARCHES` cap + `useLocationExpansionStore.prune`):
 *
 * - an **age drop** — conflicts older than {@link SYNC_CONFLICT_TTL_MS} by their
 *   `detectedAt` are dropped, since a months-stale unreviewed loss is no longer actionable;
 * - a **hard cap** — at most {@link MAX_SYNC_CONFLICTS} are kept, newest first, so a
 *   misbehaving sync can never blow the budget however many conflicts it detects.
 *
 * Keeping the maths here (the `saved-searches.ts` "logic out of the store" seam) makes it
 * directly unit-testable; the store is thin glue that supplies `Date.now()`.
 */
import type { SyncConflict } from './types';

/**
 * Newest-first ceiling on the retained backlog. Far more than any user reviews by hand, but
 * a finite backstop so a runaway sync can't grow `localStorage` without limit. The oldest
 * (tail) entries are dropped once this is exceeded.
 */
export const MAX_SYNC_CONFLICTS = 200;

/**
 * Age after which an unreviewed conflict is dropped on the next merge, keyed off its
 * `detectedAt`. Ninety days is long enough that any conflict the user cares to recover has
 * been reviewed, yet bounds the backlog for someone who never opens the Sync screen.
 */
export const SYNC_CONFLICT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Merge freshly-detected conflicts into the existing backlog, de-duplicated by id and
 * bounded by age then count.
 *
 * `incoming` is placed ahead of the backlog so the newest sync's conflicts sort first; a
 * re-detected id is identical (deterministic id + captured versions), so the first-seen
 * (incoming) copy is kept and the older duplicate dropped. Anything older than
 * {@link SYNC_CONFLICT_TTL_MS} relative to `now` is then dropped, and finally the list is
 * capped at {@link MAX_SYNC_CONFLICTS}, keeping the newest.
 */
export function mergeConflicts(
  existing: readonly SyncConflict[],
  incoming: readonly SyncConflict[],
  now: number,
): readonly SyncConflict[] {
  const oldestAllowed = now - SYNC_CONFLICT_TTL_MS;

  const byId = new Map<string, SyncConflict>();
  for (const c of [...incoming, ...existing]) {
    if (c.detectedAt < oldestAllowed) continue;
    if (!byId.has(c.id)) byId.set(c.id, c);
  }

  return [...byId.values()].slice(0, MAX_SYNC_CONFLICTS);
}
