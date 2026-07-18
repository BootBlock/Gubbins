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
 * Revision counter for the squashed `v1-initial` baseline (spec §2.3).
 *
 * While pre-release, schema changes are folded *into* the v1 baseline rather than appended as
 * forward migrations. That keeps one authoritative schema, but `PRAGMA user_version` alone
 * cannot then distinguish a database built from today's baseline from one built by an older
 * revision of it — both read as v1, so the engine applies nothing and the absent table surfaces
 * later as a cryptic "no such table" (exactly how issue #84's `location_tags` reached users).
 *
 * This counter closes that gap: the baseline stamps it into `app_meta`, and boot refuses any
 * database carrying an older (or absent) stamp with `SCHEMA_STALE`, whose rescue screen offers
 * backup-then-reset. It is a *recorded* version value, exactly like `user_version` — the schema
 * is still never inferred by inspecting `sqlite_master` (§2.3.1).
 *
 * **Bump this whenever the v1 baseline changes shape**, and bump `schemaVersion` in
 * `package.json` alongside it so the PWA update banner warns that data will not be preserved.
 */
export const BASELINE_REVISION = 2;

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
