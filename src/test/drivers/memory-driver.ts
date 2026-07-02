/**
 * Test-only synchronous in-memory database driver (spec §8.5.1, §8.5.2).
 *
 * Implements the production `IDatabaseDriver` interface over Node's built-in
 * `node:sqlite` — a real SQLite engine — so domain logic (migrations, repository
 * SQL, the Consumable Gauge maths in later phases) can be validated instantly in
 * Vitest without the Web Worker, OPFS, or WASM loading. This is the dependency
 * injected in place of the worker bridge during unit tests.
 *
 * NEVER imported by production code — it depends on a Node builtin and is excluded
 * from the application tsconfig.
 */
import { DatabaseSync } from 'node:sqlite';
import { DbError } from '@/db/errors';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlValue } from '@/db/rpc/driver';

export interface MemoryDriver extends IDatabaseDriver {
  /** The underlying synchronous handle, for white-box assertions in tests. */
  readonly raw: DatabaseSync;
}

export function createMemoryDriver(): MemoryDriver {
  const db = new DatabaseSync(':memory:');
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
function bindArgs(params?: SqlParams): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(coerce);
  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, SqlValue>)) {
    named[key] = coerce(value);
  }
  return [named];
}

function coerce(value: SqlValue): unknown {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}
