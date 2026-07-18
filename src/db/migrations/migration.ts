import type { SqlStatement } from '../rpc/driver';

/**
 * SQL expression yielding the current time as a UNIX epoch in **milliseconds**
 * (spec §7.1). Used as the canonical `updated_at` default and inside the
 * auto-stamp triggers. `unixepoch(..., 'subsec')` (SQLite 3.42+) provides
 * sub-second resolution; we round to whole milliseconds.
 */
export const SQL_NOW_MS = "CAST(ROUND(unixepoch('now', 'subsec') * 1000) AS INTEGER)";

/**
 * The `app_meta` key recording which revision of the squashed baseline built this database.
 */
export const BASELINE_REVISION_KEY = 'baseline_revision';

/**
 * Fingerprint of the squashed `v1-initial` baseline's SQL (spec §2.3).
 *
 * Gubbins is pre-release and **does not maintain backwards compatibility**: schema changes are
 * folded *into* the v1 baseline rather than appended as forward migrations, and an existing
 * database is discarded rather than migrated. That keeps one authoritative schema, but
 * `PRAGMA user_version` alone cannot then tell a database built from today's baseline from one
 * built by an older revision of it — both read as v1, so the engine applies nothing and the
 * absent table only surfaces later as a cryptic "no such table" (exactly how issue #84's
 * `location_tags` reached users' devices).
 *
 * The baseline stamps this fingerprint into `app_meta`, and boot refuses any database whose
 * stamp differs with `SCHEMA_STALE`, whose rescue screen offers backup-then-reset.
 *
 * **It is derived from the statements themselves, never hand-maintained.** A counter someone
 * must remember to bump fails in precisely the situation it exists to catch — a developer folds
 * a table into v1 and forgets — which is the original bug wearing a different hat. Deriving it
 * means editing the baseline *is* the bump. Note this reads a value the schema *records*, like
 * `user_version`; the schema is still never inferred from `sqlite_master` (§2.3.1).
 */
export function baselineFingerprint(statements: readonly SqlStatement[]): string {
  // FNV-1a over the concatenated SQL. A non-cryptographic hash is the right tool: this detects
  // honest drift between a build and a database on the same device, and nothing here is a
  // security boundary. Rendered hex so the stamp stays human-readable in `app_meta`.
  let hash = 0x811c9dc5;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      // ×16777619 in 32-bit arithmetic, via shifts to stay inside Number's safe integer range.
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
  };
  for (const { sql, params } of statements) {
    feed(sql);
    // Params too, not just SQL: a baseline statement that seeds rows through bound values would
    // otherwise change what the database *contains* without changing its fingerprint, letting
    // exactly the silent drift this guard exists to catch back in.
    // `SqlParams` is either a positional array or a named record; fold both, sorting record
    // keys so an incidental reordering isn't mistaken for a schema change.
    if (Array.isArray(params)) {
      for (const value of params) {
        feed(String(value));
      }
    } else if (params) {
      for (const key of Object.keys(params).sort()) {
        feed(`${key}=${String((params as Record<string, unknown>)[key])}`);
      }
    }
  }
  return hash.toString(16).padStart(8, '0');
}

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
