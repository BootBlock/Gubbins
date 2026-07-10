import type { SyncResult } from './sync-engine';

/** English count phrase for the small tallies a sync reports ("1 update" / "3 updates"). */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Join clauses naturally: "a", "a and b", "a, b and c". */
function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Turn a {@link SyncResult} into a plain-English sentence for the Sync screen's status line.
 *
 * The engine's raw status enum (`PUBLISHED`/`SYNCED`/`CLONED`) rendered as
 * "PUBLISHED · pulled 0 · deleted 0" reads like an error to a first-time user — a successful
 * first publish to an empty folder is exactly that string. This maps each outcome to reassuring,
 * accurate copy, states change counts in words, and only mentions the rare structural
 * adjustments (re-parenting, cycle-avoidance) when they actually happened. Pure and
 * transport-free, so it is unit-testable without rendering the screen.
 */
export function describeSyncOutcome(result: SyncResult): string {
  // HARD_STOP carries its own operator-facing message (e.g. storage nearly full); pass it through.
  if (result.status === 'HARD_STOP') return result.message ?? 'Sync paused.';

  const sentences: string[] = [];

  if (result.status === 'PUBLISHED') {
    // First publish: the sync location had no snapshot yet, so there was nothing to merge in.
    sentences.push(
      'Published — saved your library to the sync location (nothing was there yet to merge in).',
    );
  } else if (result.status === 'CLONED') {
    // §7.2 TTL full clone: rebuilt from the remote after a long time away, then republished.
    sentences.push('Re-synced — rebuilt your library from the sync location and republished it.');
  } else {
    // SYNCED — the normal two-way delta reconcile.
    const changes: string[] = [];
    if (result.pulled > 0) changes.push(`brought in ${count(result.pulled, 'update')}`);
    if (result.deleted > 0) changes.push(`removed ${count(result.deleted, 'item')}`);
    sentences.push(
      changes.length === 0
        ? 'Up to date — published your changes; nothing new to bring in.'
        : `Synced — ${joinClauses(changes)}.`,
    );
  }

  // Rare but worth surfacing plainly when they occur.
  if (result.reparented > 0) {
    sentences.push(
      `${count(result.reparented, 'item')} moved to Unassigned (its location was removed elsewhere).`,
    );
  }
  if (result.rejectedCycles > 0) {
    sentences.push(`${count(result.rejectedCycles, 'location move')} skipped to avoid a loop.`);
  }

  return sentences.join(' ');
}
