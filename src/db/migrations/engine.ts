/**
 * The versioned migration engine (spec §2.3).
 *
 * Schema state is dictated absolutely by `PRAGMA user_version` — never inferred by
 * inspecting sqlite_master (§2.3.1). On boot we read the current version and apply,
 * in strict ascending order, every migration newer than it. Each migration runs in
 * a single atomic transaction with its `user_version` bump, so a failure rolls the
 * step back entirely and halts rather than leaving a half-migrated database
 * (§2.3.2).
 *
 * Operates against the IDatabaseDriver abstraction, so the entire engine is
 * validated in unit tests against a synchronous in-memory driver (§8.5.2).
 */
import { DbError } from '../errors';
import type { IDatabaseDriver, SqlStatement } from '../rpc/driver';
import {
  BASELINE_REVISION_KEY,
  MISSING_SCHEMA_MARKERS,
  type Migration,
  type MigrationReport,
} from './migration';

/** Read the current schema version from `PRAGMA user_version` (spec §2.3.1). */
export async function getUserVersion(driver: IDatabaseDriver): Promise<number> {
  const row = await driver.queryOne<{ user_version: number | bigint }>('PRAGMA user_version;');
  return Number(row?.user_version ?? 0);
}

/**
 * Apply all outstanding migrations. Returns a report describing what ran.
 * Idempotent: a database already at the target version performs no writes.
 */
export async function runMigrations(
  driver: IDatabaseDriver,
  migrations: readonly Migration[],
): Promise<MigrationReport> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  assertValidSequence(ordered);

  const from = await getUserVersion(driver);
  const to = ordered.length === 0 ? from : ordered[ordered.length - 1]!.version;
  const applied: number[] = [];

  // A database whose version exceeds the highest migration this build knows about was
  // written by a newer or now-incompatible schema — for example a pre-release baseline
  // that has since been squashed, leaving a high `user_version` on disk (spec §2.3).
  // We must refuse to run: the engine only applies migrations *newer* than `from`, so it
  // would silently no-op and later surface as cryptic "no such table" failures against an
  // expected-but-absent table. Halt with a clear, actionable error the boot screen can act
  // on (the rescue actions offer a reset), rather than degrading downstream.
  if (ordered.length > 0 && from > to) {
    throw new DbError(
      'SCHEMA_TOO_NEW',
      `The on-device database is at schema v${from}, which is newer than this build supports (v${to}). ` +
        'This happens when the local data predates a schema change. Reset local data to rebuild it from scratch.',
    );
  }

  for (const migration of ordered) {
    if (migration.version <= from) continue;

    const statements: SqlStatement[] = [
      ...migration.statements,
      // The version value is an integer we control, not user input; PRAGMA does
      // not accept bound parameters for it, so it is inlined safely via Number().
      { sql: `PRAGMA user_version = ${Number(migration.version)};` },
    ];

    try {
      await driver.transaction(statements);
    } catch (err) {
      throw new DbError(
        'INIT_FAILED',
        `Migration v${migration.version} ("${migration.name}") failed and was rolled back; halting application start (spec §2.3.2).`,
        { cause: err },
      );
    }

    applied.push(migration.version);
  }

  return { from, to, applied };
}

/**
 * Refuse a database built from a different revision of the squashed pre-release baseline
 * (spec §2.3; issue #84).
 *
 * `user_version` only distinguishes *versions*, and while pre-release every schema change is
 * folded into v1 rather than appended as v2, v3, … So a database created before such a fold
 * still reads as v1: {@link runMigrations} correctly applies nothing, and the missing table or
 * column only surfaces much later as a cryptic "no such table" deep inside a feature — which is
 * precisely how issue #84's `location_tags` reached users' devices.
 *
 * The baseline stamps a fingerprint derived from its own DDL into `app_meta`, and this check
 * runs straight after migration. A stamp that is absent (built before stamping existed) or
 * simply *different* means the on-disk schema was built by another revision of the baseline.
 * Halt with a clear, actionable error so the boot rescue screen can offer backup-then-reset,
 * rather than degrading downstream.
 *
 * Note this reads a value the schema *records*, exactly like `user_version` — the schema is
 * still never inferred by inspecting `sqlite_master` (§2.3.1). `expected` is passed in rather
 * than imported so this engine stays independent of any one concrete baseline, exactly as the
 * rest of it is.
 *
 * A read that fails for any reason *other* than the schema being absent propagates unchanged
 * (issue #500) — see {@link readBaselineStamp}.
 */
export async function assertBaselineCurrent(driver: IDatabaseDriver, expected: string): Promise<void> {
  const stamped = await readBaselineStamp(driver);

  // Exact match, not a comparison: the stamp is a fingerprint, so "different" is the only
  // meaningful relation — a database built from any other revision of the baseline is
  // incompatible regardless of which came first.
  if (stamped !== expected) {
    throw new DbError(
      'SCHEMA_STALE',
      `The on-device database was built from baseline ${stamped ?? 'unknown'}, but this build ` +
        `expects ${expected}. Gubbins is pre-release and does not migrate existing data across ` +
        'schema changes. Back up your data if you want to keep a copy, then reset local data to ' +
        'rebuild it from scratch.',
    );
  }
}

/**
 * How many times the stamp read is attempted before its failure is reported, and how long to
 * wait between attempts. Only *retryable* lock contention is retried, so in practice this costs
 * nothing: every other outcome — a hit, a missing table, a dead worker — settles on attempt one.
 */
const STAMP_READ_ATTEMPTS = 2;
const STAMP_RETRY_DELAY_MS = 50;

/**
 * Read the baseline stamp, distinguishing *unstamped* from *unknown* (issue #500).
 *
 * The distinction is the whole point. `SCHEMA_STALE` is the one boot error that actively *tells the
 * user to purge their inventory*: its screen explains that pre-1.0 data cannot be carried forward
 * and walks them through backup-then-reset. Concluding it from a read that merely *failed* — a
 * worker timeout, a worker that died between the migration and this call, lock contention — hands
 * that advice to someone whose database is perfectly healthy, and a user who follows it loses
 * everything since their last backup for no reason. Only a database old enough to predate
 * `app_meta` (or the columns this reads) is genuinely unstamped, and SQLite says so in as many
 * words; anything else is a transient fault and propagates as itself, so the boot screen names the
 * real failure and points at a reload instead.
 *
 * Retryable lock contention gets one more go before it is reported, since a `SQLITE_BUSY` here is
 * transient by definition and stopping the boot for it helps nobody.
 */
async function readBaselineStamp(driver: IDatabaseDriver): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const row = await driver.queryOne<{ value: string | null }>(
        'SELECT value FROM app_meta WHERE key = ?;',
        [BASELINE_REVISION_KEY],
      );
      return row?.value ?? null;
    } catch (error) {
      if (isMissingSchemaError(error)) return null;
      if (attempt >= STAMP_READ_ATTEMPTS || !(error instanceof DbError && error.isRetryable)) throw error;
      await delay(STAMP_RETRY_DELAY_MS);
    }
  }
}

/**
 * True when `error` reports an absent table or column — the "this database predates the stamp"
 * case — rather than a failure to read at all.
 *
 * The code is checked as well as the text: a missing table reaches us as SQLite's own generic
 * error (or, from a driver that surfaces no result code, as `UNKNOWN`), never as one of the
 * transport or environment codes, so a `WORKER_TIMEOUT` cannot be talked into looking like a
 * stale schema by whatever its message happens to contain. Erring towards "not missing" is the
 * safe direction: it costs a genuinely ancient database the tailored explainer, not the rescue
 * actions, which the boot-failure screen offers either way.
 */
function isMissingSchemaError(error: unknown): boolean {
  if (error instanceof DbError && error.code !== 'SQLITE_ERROR' && error.code !== 'UNKNOWN') return false;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return MISSING_SCHEMA_MARKERS.some((marker) => message.includes(marker));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Guard against authoring mistakes: versions must be contiguous starting at 1. */
function assertValidSequence(ordered: readonly Migration[]): void {
  for (let index = 0; index < ordered.length; index++) {
    const expected = index + 1;
    const migration = ordered[index]!;
    if (migration.version !== expected) {
      throw new DbError(
        'INIT_FAILED',
        `Migration versions must be contiguous from 1. Expected v${expected} at position ${index}, found v${migration.version} ("${migration.name}").`,
      );
    }
  }
}
