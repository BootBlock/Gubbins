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
import type { Migration, MigrationReport } from './migration';

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
