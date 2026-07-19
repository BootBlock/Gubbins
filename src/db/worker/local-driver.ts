/**
 * An {@link IDatabaseDriver} over the worker's *own* SQLite connection (issue #173).
 *
 * The driver interface exists so the repository layer never talks to the worker directly —
 * but a coarse worker operation such as the sync merge is built from the very same
 * driver-shaped reads and writes, and re-implementing them against the raw handle would
 * fork logic that is already tested. So the worker hands itself a driver: the calls resolve
 * in-process against the live connection instead of crossing the postMessage bridge.
 *
 * This is a shim, not a second driver implementation — it reuses the worker's existing
 * query/execute/transaction bodies, so there is exactly one definition of what each does.
 * `close` deliberately throws: connection lifetime belongs to the worker's own `close`
 * request, and an operation reaching for it here would be a bug rather than a teardown.
 */
import { DbError } from '../errors';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlStatement } from '../rpc/driver';

export interface LocalDriverOps {
  query(sql: string, params?: SqlParams): SqlRow[];
  execute(sql: string, params?: SqlParams): SqlExecuteResult;
  transaction(statements: readonly SqlStatement[]): void;
}

/** Wrap the worker's synchronous SQL primitives in the async driver contract. */
export function createLocalDriver(ops: LocalDriverOps): IDatabaseDriver {
  return {
    query<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]> {
      return Promise.resolve(ops.query(sql, params) as TRow[]);
    },
    queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
      return Promise.resolve((ops.query(sql, params) as TRow[])[0]);
    },
    execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult> {
      return Promise.resolve(ops.execute(sql, params));
    },
    transaction(statements: readonly SqlStatement[]): Promise<void> {
      ops.transaction(statements);
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.reject(
        new DbError('UNKNOWN', 'The in-worker driver does not own the connection and cannot close it.'),
      );
    },
  };
}
