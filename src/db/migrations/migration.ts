import type { SqlStatement } from '../rpc/driver';

/**
 * SQL expression yielding the current time as a UNIX epoch in **milliseconds**
 * (spec §7.1). Used as the canonical `updated_at` default and inside the
 * auto-stamp triggers. `unixepoch(..., 'subsec')` (SQLite 3.42+) provides
 * sub-second resolution; we round to whole milliseconds.
 */
export const SQL_NOW_MS = "CAST(ROUND(unixepoch('now', 'subsec') * 1000) AS INTEGER)";

/**
 * A single, immutable schema migration that upgrades the database to `version`.
 * Statements run together inside one atomic transaction, followed by a
 * `PRAGMA user_version = <version>` bump (spec §2.3.2). Migrations are never
 * edited once shipped — corrections ship as a new, higher-versioned migration.
 */
export interface Migration {
  /** Target schema version this migration produces (contiguous, starting at 1). */
  readonly version: number;
  /** Human-readable label for diagnostics and handover docs. */
  readonly name: string;
  /** Ordered DDL/seed statements that bring the schema up to `version`. */
  readonly statements: readonly SqlStatement[];
}

export interface MigrationReport {
  /** Schema version before migration. */
  readonly from: number;
  /** Schema version after migration (the target). */
  readonly to: number;
  /** Versions actually applied during this run, in order. */
  readonly applied: readonly number[];
}
