/**
 * The database driver abstraction (spec §2.1.1, §8.5.1).
 *
 * The Repository layer depends on this interface — never on the worker, the
 * postMessage bridge or the SQLite WASM binary directly. Dependency injection of
 * the concrete driver lets the production worker bridge be swapped for a
 * synchronous in-memory (`:memory:`) driver inside the test suite (§8.5.2),
 * keeping unit tests instantaneous and browser-API-free.
 */

/** A value that can be bound to, or read from, a SQLite column. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** Positional (array) or named (object) statement parameters. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

/** A generic result row keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

/** A single statement plus its parameters, for atomic batched execution. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: SqlParams;
}

/** Outcome metadata for a mutating statement. */
export interface SqlExecuteResult {
  /** Rows changed by the most recent INSERT/UPDATE/DELETE. */
  readonly rowsModified: number;
  /** rowid of the last inserted row, or null when not applicable. */
  readonly lastInsertRowId: number | null;
}

export interface IDatabaseDriver {
  /** Run a row-returning statement and marshal every row back. */
  query<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]>;

  /** Convenience: the first row, or `undefined` when the result set is empty. */
  queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined>;

  /** Run a single non-returning statement (INSERT/UPDATE/DELETE/DDL). */
  execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult>;

  /**
   * Execute many statements atomically inside a single BEGIN…COMMIT, rolling back
   * on any error (spec §2.3.2). Batched rather than callback-based so atomicity
   * survives the worker bridge without interleaving with the write queue.
   */
  transaction(statements: readonly SqlStatement[]): Promise<void>;

  /** Release the connection and any underlying worker resources. */
  close(): Promise<void>;
}
