/**
 * The application-wide database client (main thread).
 *
 * Owns the single WorkerDatabaseDriver instance and the boot orchestration that
 * §2.3.2 mandates: open the OPFS connection (verifying FTS5), then apply any
 * outstanding migrations before the UI is allowed to use the database. Kept as a
 * module singleton so the worker — which holds the exclusive OPFS write lock — is
 * created exactly once per tab.
 */
import { WorkerDatabaseDriver } from './rpc/worker-driver';
import { BASELINE_REVISION, assertBaselineCurrent, migrations, runMigrations } from './migrations';
import type { DbDiagnostics } from './rpc/protocol';
import type { MigrationReport } from './migrations';

let driver: WorkerDatabaseDriver | null = null;

/** Lazily construct (once) and return the shared database driver. */
export function getDatabaseDriver(): WorkerDatabaseDriver {
  driver ??= new WorkerDatabaseDriver();
  return driver;
}

export interface DbBootResult {
  readonly diagnostics: DbDiagnostics;
  readonly migration: MigrationReport;
}

/**
 * Boot the database: connect + verify FTS5, then migrate to the target schema.
 * Throws a typed DbError if the environment is unsupported (no OPFS / FTS5) or a
 * migration fails — callers surface this as a blocking screen (spec §2.2.6, §3).
 */
export async function bootDatabase(): Promise<DbBootResult> {
  const db = getDatabaseDriver();
  const initial = await db.init();
  const migration = await runMigrations(db, migrations);
  // A database at the target version may still predate the current squashed baseline; refuse
  // it here rather than letting the absent schema surface as a cryptic failure later (§2.3).
  await assertBaselineCurrent(db, BASELINE_REVISION);
  // After migration the schema version is the migration target; avoid an extra
  // round-trip by deriving the post-boot diagnostics locally.
  const diagnostics: DbDiagnostics = { ...initial, userVersion: migration.to };
  return { diagnostics, migration };
}

/**
 * How many items the database currently holds (issue #505).
 *
 * Recorded outside the database on each boot so that, if the browser later evicts the database,
 * the notice can say how much was here rather than only that something was. Goes straight to the
 * driver rather than through `ItemRepository` because it runs during boot, before any actor or
 * permission context exists — and it is a whole-table count, not a filtered read.
 */
export async function countStoredItems(): Promise<number> {
  const row = await getDatabaseDriver().queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM items;');
  return Number(row?.n ?? 0);
}

/**
 * The database driver, replacing the worker first if the one it holds is already dead.
 *
 * A crashed worker latches the driver permanently unusable (issue #299) — sound for ordinary
 * calls, but the Safe Mode rescues run on the crash screen, and under the `opfs-sahpool` VFS the
 * database can *only* be reached through a worker. Refusing there would make the recovery
 * unavailable in exactly the state it exists for. The dead worker has already been terminated,
 * so the file handles it held are released and a fresh one can take them.
 *
 * **Every** rescue action goes through this, not just the destructive ones (issue #503): a
 * crashed worker is one of the main reasons a user is looking at Safe Mode, and it used to be
 * the "get your data out" half — the backup, the `.sqlite` copy, the JSON dump — that failed
 * against it while the irreversible purge self-healed and succeeded.
 */
export async function getRescueDatabaseDriver(): Promise<WorkerDatabaseDriver> {
  if (getDatabaseDriver().isUnavailable) await disposeDatabase();
  return getDatabaseDriver();
}

/** Tear down the database client (used by the Safe Mode hard-reset, spec §3). */
export async function disposeDatabase(): Promise<void> {
  const current = driver;
  driver = null;
  if (!current) return;
  try {
    await current.close();
  } catch {
    current.dispose();
  }
}
