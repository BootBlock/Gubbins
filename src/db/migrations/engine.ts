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
import { BASELINE_REVISION, BASELINE_REVISION_KEY, type Migration, type MigrationReport } from './migration';

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
 * Refuse a database built by an *older* revision of the squashed pre-release baseline
 * (spec §2.3; issue #84).
 *
 * `user_version` only distinguishes *versions*, and while pre-release every schema change is
 * folded into v1 rather than appended as v2, v3, … So a database created before such a fold
 * still reads as v1: {@link runMigrations} correctly applies nothing, and the missing table or
 * column only surfaces much later as a cryptic "no such table" deep inside a feature — which is
 * precisely how issue #84's `location_tags` reached users' devices.
 *
 * The baseline therefore stamps {@link BASELINE_REVISION} into `app_meta`, and this check runs
 * straight after migration: an absent stamp (built before stamping existed) or a lower one means
 * the on-disk schema predates this build's baseline. Halt with a clear, actionable error so the
 * boot rescue screen can offer backup-then-reset, rather than degrading downstream.
 *
 * Note this reads a value the schema *records*, exactly like `user_version` — the schema is
 * still never inferred by inspecting `sqlite_master` (§2.3.1).
 */
export async function assertBaselineCurrent(driver: IDatabaseDriver): Promise<void> {
  // A database old enough to predate `app_meta` itself makes this read throw "no such table".
  // That is the *most* stale case there is, so treat it as revision 0 rather than letting a raw
  // SQLITE_ERROR through — a generic "failed to initialise" screen offers no way forward, which
  // is exactly the cryptic outcome this guard exists to replace.
  let stamped = 0;
  try {
    const row = await driver.queryOne<{ value: string | null }>('SELECT value FROM app_meta WHERE key = ?;', [
      BASELINE_REVISION_KEY,
    ]);
    // A malformed stamp is not trustworthy evidence of a current schema: coerce anything
    // non-numeric to 0 so it fails the check below rather than slipping through as NaN
    // (NaN < BASELINE_REVISION is false, which would silently *pass*).
    const parsed = Number(row?.value ?? 0);
    stamped = Number.isFinite(parsed) ? parsed : 0;
  } catch {
    stamped = 0;
  }

  if (stamped < BASELINE_REVISION) {
    throw new DbError(
      'SCHEMA_STALE',
      `The on-device database was built from baseline revision ${stamped || 'unknown'}, but this ` +
        `build expects revision ${BASELINE_REVISION}. Gubbins is pre-release, so schema changes are ` +
        'not migrated automatically. Back up your data if you want to keep a copy, then reset local ' +
        'data to rebuild it from scratch.',
    );
  }
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
