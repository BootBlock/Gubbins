/**
 * The `locations` "at most one default" invariant, shared across every sync write path (issue #191).
 *
 * A location's `is_default` flag marks the single place "Add item" pre-selects. The schema now
 * guards it with a partial unique index (`… WHERE is_default = 1`), but per-row last-write-wins
 * cannot see across rows: two devices that each nominate a *different* default while offline
 * converge to two rows sharing the flag (their demote-UPDATEs touched different siblings, so
 * neither demotion crosses the merge). Left unrepaired that either trips the index (`restoreSnapshot`'s
 * `ON CONFLICT(id)` upsert aborts the whole restore) or, worse, silently collapses a row
 * (`buildCloneStatements`' `INSERT OR REPLACE` deletes the conflicting row wholesale). This module
 * reduces a set of location rows to one deterministic winner before they are written; the reconcile
 * engine's own cross-row repair of the delta path uses the same {@link flagWinner} rule.
 *
 * This is the structural twin of `supplier-part-flags` (issues #157 / #192) — it reuses that
 * module's generic {@link flagWinner} tiebreak — but `is_default` is a **global** single-default:
 * the winner is chosen across the whole table, not within a per-item group.
 */
import type { SqlRow } from '@/db/rpc/driver';
import { flagWinner, type FlagRanked } from './supplier-part-flags';

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

/**
 * The id that should keep `is_default = 1` among `rows` — the deterministic winner by
 * {@link flagWinner} (newest `updated_at`, ties broken by the smaller id so every device and write
 * path agrees) — or `null` when none carries the flag.
 */
export function defaultLocationWinner(rows: readonly SqlRow[]): string | null {
  let winner: FlagRanked | null = null;
  for (const r of rows) {
    if (num(r.is_default) !== 1) continue;
    const candidate: FlagRanked = { id: String(r.id), updatedAt: num(r.updated_at) };
    if (!winner || flagWinner(candidate, winner) === candidate) winner = candidate;
  }
  return winner ? winner.id : null;
}

/**
 * Return a copy of `rows` in which at most one carries `is_default = 1` (the winner); every other
 * row that carried it is cleared to 0. Rows without the flag pass through untouched. Pure — the
 * input is never mutated.
 */
export function dedupeDefaultLocations(rows: readonly SqlRow[]): SqlRow[] {
  const winnerId = defaultLocationWinner(rows);
  return rows.map((r) =>
    winnerId !== null && num(r.is_default) === 1 && String(r.id) !== winnerId
      ? { ...r, is_default: 0 }
      : { ...r },
  );
}
