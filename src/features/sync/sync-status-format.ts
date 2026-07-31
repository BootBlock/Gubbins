import { assertExhaustive } from '@/lib/exhaustive';
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
 * What the two-way merge moved — "brought in 2 updates and removed 1 item" — or `''` when it
 * moved nothing. Shared by the completed sync and the merge whose push failed (#638): both
 * describe the *same* local merge, so they must count it the same way.
 */
function changeClauses(result: SyncResult): string {
  const changes: string[] = [];
  if (result.pulled > 0) changes.push(`brought in ${count(result.pulled, 'update')}`);
  if (result.deleted > 0) changes.push(`removed ${count(result.deleted, 'item')}`);
  return joinClauses(changes);
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
  const sentences: string[] = [];

  switch (result.status) {
    case 'HARD_STOP':
      // Carries its own operator-facing message (e.g. storage nearly full); pass it through.
      return result.message ?? 'Sync paused.';
    case 'PUBLISHED':
      // First publish: the sync location had no snapshot yet, so there was nothing to merge in.
      sentences.push(
        'Published — saved your library to the sync location (nothing was there yet to merge in).',
      );
      break;
    case 'CLONED':
      // §7.2 TTL full clone: rebuilt from the remote after a long time away, then republished.
      sentences.push('Re-synced — rebuilt your library from the sync location and republished it.');
      break;
    case 'MERGED_NOT_PUBLISHED': {
      // Issue #638: the pull landed and is committed here; only the upload failed. Say both
      // halves — "Sync failed" alone reads as "nothing happened", which is the opposite of true.
      const changes = changeClauses(result);
      sentences.push(
        changes === ''
          ? 'Merged on this device, but publishing to the sync location failed — your changes will publish next time you sync.'
          : `Merged on this device — ${changes} — but publishing to the sync location failed; your changes will publish next time you sync.`,
      );
      break;
    }
    case 'SYNCED': {
      // The normal two-way delta reconcile.
      const changes = changeClauses(result);
      sentences.push(
        changes === ''
          ? 'Up to date — published your changes; nothing new to bring in.'
          : `Synced — ${changes}.`,
      );
      break;
    }
    default:
      assertExhaustive(result.status);
  }

  // Rare but worth surfacing plainly when they occur.
  if (result.reparented > 0) {
    sentences.push(
      `${count(result.reparented, 'item')} moved to Unassigned (its location was removed elsewhere).`,
    );
  }
  if (result.rejectedCycles > 0) {
    sentences.push(`${count(result.rejectedCycles, 'nesting change')} skipped to avoid a loop.`);
  }
  // Issue #193: a serialised item was lent out on two devices at once; the merge kept the first loan.
  if (result.serialisedLoansClosed > 0) {
    sentences.push(
      `${count(result.serialisedLoansClosed, 'duplicate loan')} closed (an item was already checked out elsewhere).`,
    );
  }
  // Issue #194: an asset was booked for overlapping dates on two devices; the merge kept the first.
  if (result.bookingsCancelled > 0) {
    sentences.push(
      `${count(result.bookingsCancelled, 'overlapping booking')} cancelled (an asset was already booked for those dates elsewhere).`,
    );
  }
  // Issue #72: a concurrent edit of yours was overwritten — flag it plainly so it can be reviewed.
  if (result.conflicts.length > 0) {
    sentences.push(
      `${count(result.conflicts.length, 'of your edits was', 'of your edits were')} overwritten — review to keep or restore ${result.conflicts.length === 1 ? 'it' : 'them'}.`,
    );
  }

  return sentences.join(' ');
}
