/**
 * Telling a write that *failed* apart from one whose outcome is simply **unknown** (issue #554).
 *
 * Every other database failure is an answer: the worker ran the statement, refused it, and said
 * so — nothing was stored, and saying "that didn't save" is true. `WORKER_TIMEOUT` is not an
 * answer. It means the worker did not reply inside its budget, and nothing in the RPC protocol
 * cancels a request, so the write may still be queued, still executing, or already committed. The
 * app cannot know which, and the two ways it used to guess were both harmful:
 *
 *  - **Rolling an optimistic patch back** asserts the change did not happen, so the user is shown
 *    "undone" over a value the database is about to contradict on the next read.
 *  - **Inviting a retry** ("try again") is dangerous for an append-only write. A revaluation, a
 *    stock delta, a test record or an item-history entry mints a fresh id per attempt, so retrying
 *    over a write that did land records the same event twice — permanently, and silently.
 *
 * So callers stop asserting either outcome: leave the patch for the refetch to settle, and tell
 * the user to check rather than to repeat. That converges on the truth whichever way it went.
 *
 * Pure and catalog-free, like its neighbour `db-error-message.ts` — the copy lives in the
 * catalogs, and `useReportWriteFailure` is what binds this to it.
 */
import { DbError } from '@/db/errors';

/**
 * True when `error` leaves the write's outcome unknown rather than proving it failed.
 *
 * Deliberately *not* `WORKER_UNAVAILABLE`: a latched, terminated worker cannot have gone on to
 * commit anything it had not already replied about, and its copy correctly tells the user to
 * reload. Only the timeout is genuinely ambiguous.
 */
export function isUnknownWriteOutcome(error: unknown): boolean {
  return error instanceof DbError && error.code === 'WORKER_TIMEOUT';
}
