/**
 * Describing a thrown value, in one place.
 *
 * `catch` gives you `unknown` — it may be an `Error`, but it may equally be a string, `undefined`,
 * or a rejected value from a library that throws plain objects. Every log line and wrapped error in
 * the bridge therefore needs the same narrowing, and it had grown seven inline copies of
 * `err instanceof Error ? err.message : String(err)` plus two private helpers spelling it two more
 * ways. One definition each, so a reader never has to work out which variant a call site meant.
 *
 * Two variants, because there are genuinely two jobs:
 *
 * - {@link errorMessage} — just the message. What belongs in a wrapped error or a user-visible
 *   string, where an errno code is noise the reader can't act on.
 * - {@link errorDetail} — the message plus the errno code when there is one. What belongs in a
 *   *diagnostic* log, where `EMFILE` vs `ENOENT` is the whole answer and the message alone
 *   ("too many open files") does not say which limit was hit.
 */

/** The message of a thrown value, whatever it turned out to be. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * As {@link errorMessage}, but appending the errno code (`EMFILE`, `ECONNREFUSED`, …) when the
 * thrown value carries one — the detail that turns "an operation failed" into an actionable log
 * line. Use it for diagnostics; use {@link errorMessage} for anything a user reads.
 */
export function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  return code === undefined ? err.message : `${err.message} (${code})`;
}
