/**
 * Atomic batch execution for the database worker (spec §2.3.2, issue #555).
 *
 * A batch that fails is rolled back — but **the rollback itself can fail**, and the fault that
 * breaks a `COMMIT` (an `SQLITE_FULL` or `SQLITE_IOERR` out of the OPFS VFS, a sync access handle
 * lost mid-transaction) is generally the same fault that then breaks the `ROLLBACK`. Swallowing
 * that second failure to preserve the original error leaves the one SQLite connection this tab
 * owns sitting *inside an open transaction*, and nothing downstream can see it: plain `execute`
 * and `query` calls enlist in it silently, report truthful row counts and read their own
 * uncommitted rows straight back. Every later write looks saved, right up until the tab is
 * reloaded and SQLite discards the lot.
 *
 * So the rule is not about the error at all: **never keep serving a connection that cannot be
 * proven out of its transaction.** SQLite's own autocommit flag is that proof — cleared by
 * `BEGIN`, restored by `COMMIT`, by `ROLLBACK`, and by the automatic rollback SQLite performs for
 * exactly the fatal errors that make a rollback impossible. If it is still clear once the unwind
 * has been attempted, the connection is discarded and the next request opens a clean one, losing
 * the uncommittable work — which is the correct outcome, and the one the user already believes
 * happened.
 *
 * The original failure is still what gets reported, so nothing is masked: it keeps its code (a
 * disk-full stays `SQLITE_FULL`, and so still humanises into the sentence that tells the user
 * what to do about it), and the rollback failure rides along as the `cause`.
 *
 * This lives apart from the worker so it can be driven directly in tests: a failing `ROLLBACK` is
 * the one path that cannot be reached through a real connection.
 */
import { DbError } from '../errors';
import type { SqlParams, SqlStatement } from '../rpc/driver';

/** The slice of a live connection a transaction needs — deliberately tiny, so tests can stand it up. */
export interface TransactionConnection {
  /** Run one statement on the connection. */
  exec(sql: string, params?: SqlParams): void;
  /** True while the connection is inside a transaction (SQLite's autocommit flag is clear). */
  inTransaction(): boolean;
  /** Release the connection, so the next request opens a fresh one. */
  discard(): void;
}

/** Appended to the reported failure when the connection had to be thrown away to escape it. */
const CONNECTION_RESET_NOTE =
  'Rolling the change back failed, so the database connection was reset and the change was discarded.';

/**
 * Execute `statements` atomically: BEGIN, run all, COMMIT; unwind on any error.
 *
 * `BEGIN` is inside the guarded region on purpose — if it is the statement that fails (a stray
 * transaction from some earlier fault would fail it with "cannot start a transaction within a
 * transaction"), the unwind below still runs and still checks the connection, rather than
 * propagating with its state unexamined.
 */
export function executeTransaction(
  connection: TransactionConnection,
  statements: readonly SqlStatement[],
): void {
  try {
    connection.exec('BEGIN;');
    for (const statement of statements) {
      connection.exec(statement.sql, statement.params);
    }
    connection.exec('COMMIT;');
  } catch (failure) {
    throw unwind(connection, failure);
  }
}

/** Roll the failed batch back, and give up the connection if that cannot be done. */
function unwind(connection: TransactionConnection, failure: unknown): DbError {
  let rollbackFailure: unknown;
  try {
    connection.exec('ROLLBACK;');
  } catch (error) {
    rollbackFailure = error;
  }

  const reported = DbError.fromUnknown(failure);

  // Clean connection — including when `ROLLBACK` threw only because SQLite had already rolled the
  // transaction back itself. A failed rollback must not mask the error that caused it.
  if (!stillInTransaction(connection)) return reported;

  connection.discard();
  return new DbError(reported.code, `${reported.message} ${CONNECTION_RESET_NOTE}`, {
    resultCode: reported.resultCode,
    sql: reported.sql,
    cause: rollbackFailure ?? failure,
  });
}

/**
 * Read the transaction state, treating an unreadable answer as "still open".
 *
 * Failing this way round costs at most a reconnect the batch did not need; failing the other way
 * is the data loss this whole module exists to prevent. It also keeps a throw from *here* — which
 * would be a fault in the guard, not in the batch — from becoming the error the user is shown in
 * place of the one that actually failed.
 */
function stillInTransaction(connection: TransactionConnection): boolean {
  try {
    return connection.inTransaction();
  } catch {
    return true;
  }
}
