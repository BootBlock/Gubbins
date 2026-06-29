/**
 * Headless, synchronous `node:sqlite` database driver for the bridge.
 *
 * This is a Node-runnable sibling of the app's test-only
 * `src/test/drivers/memory-driver.ts`: both implement the production
 * {@link IDatabaseDriver} over Node's built-in `node:sqlite` engine (a real SQLite
 * with FTS5), so the *exact* migration engine, repositories and search code the PWA
 * ships run unchanged here. The test driver lives under `src/test/**` (excluded from
 * the app tsconfig) and is `@/`-aliased for Vitest; rather than widen the app's
 * tsconfig to drag a test module into a Node build, the bridge keeps this small,
 * dependency-injected copy. The driver is plumbing, not search semantics — the one
 * thing that must never be forked, `parseASTtoSQL`, is imported, never copied.
 *
 * The bridge is strictly read-only at the API level, but the driver still exposes
 * the full write surface because *hydration itself* writes: the migration engine
 * creates the schema and `restoreSnapshot` UPSERTs the snapshot rows. After
 * hydration nothing in the query path mutates.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DbError } from '@/db/errors';
import type {
  IDatabaseDriver,
  SqlExecuteResult,
  SqlParams,
  SqlRow,
  SqlValue,
} from '@/db/rpc/driver';

export interface NodeDriver extends IDatabaseDriver {
  /** The underlying synchronous handle, for white-box assertions in tests. */
  readonly raw: DatabaseSync;
}

/**
 * Create a `node:sqlite`-backed driver implementing {@link IDatabaseDriver}.
 *
 * `location` defaults to `':memory:'` (the JSON-snapshot hydration path builds a fresh,
 * private in-memory DB). The **Direct `.sqlite` data source** points it at a *file* instead
 * — always a private temp copy of the user's raw export (never the original), so the
 * migration engine can write FTS5/triggers/derived tables onto an older export and any
 * `-journal`/`-wal` sidecars stay in temp. Either way the same production driver, schema and
 * repositories run unchanged.
 */
export function createNodeDriver(location = ':memory:'): NodeDriver {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA foreign_keys = ON;');

  return {
    raw: db,

    async query<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]> {
      try {
        return db.prepare(sql).all(...bindArgs(params)) as TRow[];
      } catch (err) {
        throw DbError.fromUnknown(err, 'SQLITE_ERROR', sql);
      }
    },

    async queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
      try {
        const row = db.prepare(sql).get(...bindArgs(params));
        return (row ?? undefined) as TRow | undefined;
      } catch (err) {
        throw DbError.fromUnknown(err, 'SQLITE_ERROR', sql);
      }
    },

    async execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult> {
      try {
        const result = db.prepare(sql).run(...bindArgs(params));
        return {
          rowsModified: Number(result.changes),
          lastInsertRowId: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
        };
      } catch (err) {
        throw DbError.fromUnknown(err, 'SQLITE_ERROR', sql);
      }
    },

    async transaction(statements): Promise<void> {
      db.exec('BEGIN;');
      try {
        for (const statement of statements) {
          if (statement.params === undefined) {
            db.exec(statement.sql);
          } else {
            db.prepare(statement.sql).run(...bindArgs(statement.params));
          }
        }
        db.exec('COMMIT;');
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Preserve the original failure.
        }
        throw DbError.fromUnknown(err, 'TRANSACTION_FAILED');
      }
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}

/** Convert our SqlParams into node:sqlite bind arguments (booleans → 0/1). */
function bindArgs(params?: SqlParams): SQLInputValue[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(coerce);
  const named: Record<string, SQLInputValue> = {};
  for (const [key, value] of Object.entries(params as Record<string, SqlValue>)) {
    named[key] = coerce(value);
  }
  // node:sqlite accepts a named-parameters object as the single leading bound
  // argument (the StatementSync.all/get/run overload); model it as that one arg.
  return [named as unknown as SQLInputValue];
}

function coerce(value: SqlValue): SQLInputValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}
