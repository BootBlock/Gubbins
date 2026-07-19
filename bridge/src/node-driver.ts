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
 *
 * The driver keeps a bounded, least-recently-used cache of compiled statements. The
 * bridge is a long-lived process answering the same handful of statement texts over and
 * over (a polling Home Assistant integration, a repeated OData list), and `node:sqlite`
 * re-parses and re-plans on every `prepare()`; caching removes that per-request cost.
 */
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { DbError } from '@/db/errors';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlValue } from '@/db/rpc/driver';

export interface NodeDriver extends IDatabaseDriver {
  /** The underlying synchronous handle, for white-box assertions in tests. */
  readonly raw: DatabaseSync;

  /**
   * How many compiled statements are currently held by the prepared-statement cache.
   * Exposed for tests (and diagnostics) only — nothing in the query path reads it.
   */
  readonly cachedStatementCount: number;
}

/**
 * Upper bound on the prepared-statement cache.
 *
 * The cache must be **bounded**, not merely "small in practice": statement *texts* are
 * caller-influenced even though the values are always bound parameters. A search or an
 * OData `$filter` compiles through `parseASTtoSQL`, whose WHERE clause shape varies with
 * the caller's query (term count, nesting, capability filters), and several repository
 * reads build an `IN (?, ?, …)` list whose placeholder count varies with the page size.
 * Those are distinct cache keys, so an unbounded `Map` would grow with traffic on a
 * long-lived bridge process. A least-recently-used bound keeps the hot, repeated
 * statements — exactly the polling/list traffic this cache exists for — while capping
 * the number of compiled statements SQLite holds open.
 */
const STATEMENT_CACHE_LIMIT = 256;

/**
 * Statements not worth caching. These run once (migrations, `restoreSnapshot`) or are
 * cheap one-off introspection, so a cache entry would only occupy a slot a hot statement
 * could use. Note this is deliberately *wider* than {@link INVALIDATES_CACHE}: a read-only
 * `PRAGMA page_count` is pointless to cache but must **not** flush the cache — a caller
 * polling diagnostics would otherwise defeat the cache entirely.
 */
const NOT_WORTH_CACHING = /^\s*(?:CREATE|DROP|ALTER|REINDEX|VACUUM|PRAGMA|ATTACH|DETACH)\b/i;

/**
 * Statements that can invalidate an already-compiled statement, by changing the schema
 * out from under it. Only these clear the cache.
 *
 * SQLite already re-plans a cached statement automatically when the schema changes
 * (statements are compiled with `sqlite3_prepare_v2`), so this is belt and braces rather
 * than the sole line of defence — but it runs on the migration path only, which happens
 * once at hydration and is not hot.
 */
const INVALIDATES_CACHE = /\b(?:CREATE|DROP|ALTER|REINDEX|VACUUM)\b/i;

function isNotWorthCaching(sql: string): boolean {
  return NOT_WORTH_CACHING.test(sql);
}

/**
 * Whether a statement *or* a multi-statement script may change the schema. Scripts run
 * through `exec` are not parsed, so this scans the whole text for a DDL keyword rather
 * than only the leading one — over-invalidating is safe, under-invalidating is not.
 */
function mayChangeSchema(sql: string): boolean {
  return INVALIDATES_CACHE.test(sql);
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

  /**
   * SQL text → compiled statement, in least-recently-used order.
   *
   * A `Map` iterates in insertion order, so "touch on hit" (delete + re-set) makes the
   * first key the least-recently-used one, and eviction is a single `keys().next()`.
   * SQLite re-plans a cached statement automatically when the schema changes underneath
   * it (statements are compiled with `sqlite3_prepare_v2`), so a cached statement cannot
   * silently execute against a stale schema; the explicit invalidation below is belt and
   * braces for the migration/DDL path, which runs once and is not hot.
   */
  const statementCache = new Map<string, StatementSync>();

  /** Compile `sql`, reusing the cached statement when there is one. */
  function prepare(sql: string): StatementSync {
    if (isNotWorthCaching(sql)) {
      // DDL can invalidate what is already cached (a dropped or altered table); drop
      // everything rather than reason about which statements a given DDL touches. A
      // read-only PRAGMA reaches here too, but must leave the cache alone.
      if (mayChangeSchema(sql)) statementCache.clear();
      return db.prepare(sql);
    }

    const cached = statementCache.get(sql);
    if (cached !== undefined) {
      // Touch: move to the most-recently-used end.
      statementCache.delete(sql);
      statementCache.set(sql, cached);
      return cached;
    }

    // Prepare *before* evicting, so a statement that fails to compile neither enters the
    // cache nor costs us a live entry.
    const statement = db.prepare(sql);
    if (statementCache.size >= STATEMENT_CACHE_LIMIT) {
      const oldest = statementCache.keys().next();
      if (!oldest.done) statementCache.delete(oldest.value);
    }
    statementCache.set(sql, statement);
    return statement;
  }

  return {
    raw: db,

    get cachedStatementCount(): number {
      return statementCache.size;
    },

    async query<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]> {
      try {
        return prepare(sql).all(...bindArgs(params)) as TRow[];
      } catch (err) {
        throw DbError.fromUnknown(err, 'SQLITE_ERROR', sql);
      }
    },

    async queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
      try {
        const row = prepare(sql).get(...bindArgs(params));
        return (row ?? undefined) as TRow | undefined;
      } catch (err) {
        throw DbError.fromUnknown(err, 'SQLITE_ERROR', sql);
      }
    },

    async execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult> {
      try {
        const result = prepare(sql).run(...bindArgs(params));
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
            // `exec` accepts multi-statement scripts, so DDL can appear anywhere in the
            // text, not just at the front — scan the whole script.
            if (mayChangeSchema(statement.sql)) statementCache.clear();
            db.exec(statement.sql);
          } else {
            prepare(statement.sql).run(...bindArgs(statement.params));
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
      // Drop our references first: `close()` finalises every statement the connection
      // owns, so a retained entry would be a handle to an already-finalised statement.
      statementCache.clear();
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
