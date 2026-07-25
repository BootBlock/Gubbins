/**
 * SQLite WASM bootstrap (spec §2.2.1, §2.2.1a, §1.2).
 *
 * Instantiates the official @sqlite.org/sqlite-wasm module, opens the database on an
 * **OPFS-backed VFS** (never IndexedDB/:memory: in production), enables foreign-key
 * enforcement, and performs a hard runtime probe that FTS5 is compiled in. Any missing
 * prerequisite throws a typed DbError so the worker can report it cleanly rather than
 * silently degrading.
 *
 * Two VFSes, one rule (issue #255). The primary `opfs` VFS needs a cross-origin-isolated
 * context and, on WebKit, Safari 17+ — so on iOS 16, or anywhere the service-worker-injected
 * COOP/COEP headers do not survive, sqlite-wasm never registers it and the boot used to fail
 * outright. The `opfs-sahpool` VFS needs neither, and its single-connection constraint already
 * matches the single-writer design the tab lock enforces (§2.2.7), so it is opened instead.
 * *Which* one is used is decided by `detectDbStorageLayout` from what is already on disk (see
 * db-storage.ts) — preferring one over an existing database in the other would present an
 * empty app beside data that is still there.
 *
 * Runs exclusively inside the database Web Worker (§2.2.2).
 */
import sqlite3InitModule, {
  type OpfsDatabase,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import { DbError } from '../errors';
import { DB_FILENAME } from '../db-file';
import { OPFS_VFS, SAHPOOL_DIRECTORY, detectDbStorageLayout } from '../db-storage';
import type { DbDiagnostics } from '../rpc/protocol';

/**
 * How many files the SAHPool VFS keeps open. One database needs slots for itself, its rollback
 * journal and a temp file; the library's guidance is "at least twice the number of expected
 * database files… may need to be higher than three times". Eight is that, with room for the
 * transient extra a restore's import takes — and eight open handles cost nothing. Only ever
 * read when the pool is first created.
 */
const SAHPOOL_CAPACITY = 8;

export interface BootstrapResult {
  readonly sqlite3: Sqlite3Static;
  readonly db: OpfsDatabase;
  readonly sqliteVersion: string;
  readonly fts5Available: boolean;
  readonly vfs: string;
  readonly filename: string;
}

/**
 * The SQLite WASM module, instantiated at most once per worker.
 *
 * Separated from {@link bootstrapDatabase} because verifying a *candidate* database
 * (issue #198) needs the library but must never open — or require — the live OPFS one:
 * Safe Mode is precisely where that open is what failed.
 */
let modulePromise: Promise<Sqlite3Static> | null = null;

/** Instantiate (once) and return the SQLite WASM module. */
export function loadSqlite3(): Promise<Sqlite3Static> {
  modulePromise ??= sqlite3InitModule();
  return modulePromise;
}

/** The SAHPool VFS, installed at most once per worker. */
let poolPromise: Promise<SAHPoolUtil> | null = null;

/**
 * Install (once) and return the SAHPool VFS.
 *
 * Also the only way to reach the database *file* under that VFS: the pool stores its files
 * under opaque names it maps internally, so this handle — not an OPFS directory listing — is
 * what reads, replaces or clears them (see db-file-store.ts).
 */
export function loadSahPool(): Promise<SAHPoolUtil> {
  poolPromise ??= loadSqlite3().then((sqlite3) => {
    if (typeof sqlite3.installOpfsSAHPoolVfs !== 'function') {
      throw new DbError(
        'OPFS_UNAVAILABLE',
        'This SQLite build offers neither the OPFS VFS nor its opfs-sahpool fallback, so Gubbins has nowhere to store your data.',
      );
    }
    return sqlite3.installOpfsSAHPoolVfs({
      directory: SAHPOOL_DIRECTORY,
      initialCapacity: SAHPOOL_CAPACITY,
    });
  });
  return poolPromise;
}

/** Which VFS a database opened *right now* would live on. */
export type DbVfsTarget = 'opfs' | 'sahpool';

/**
 * Resolve the VFS to use: whichever already holds this origin's database, and only where there
 * is none, whichever this browser can actually provide.
 *
 * Shared with the file-store operations so a restore writes where the next boot will read
 * (issue #255) — including on a fresh install, where nothing on disk answers the question and
 * only the loaded module can say whether the primary VFS registered.
 */
export async function resolveVfsTarget(): Promise<DbVfsTarget> {
  const layout = await detectDbStorageLayout();
  if (layout !== 'none') return layout === 'opfs' ? 'opfs' : 'sahpool';
  return hasPrimaryVfs(await loadSqlite3()) ? 'opfs' : 'sahpool';
}

export async function bootstrapDatabase(): Promise<BootstrapResult> {
  const sqlite3 = await loadSqlite3();
  const { db, vfs } = await openConnection(sqlite3);

  try {
    // Enforce referential integrity for every connection (spec §7.5 relies on it).
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (err) {
    db.close();
    throw DbError.fromUnknown(err, 'INIT_FAILED');
  }

  const fts5Available = probeFts5(db);
  if (!fts5Available) {
    db.close();
    throw new DbError(
      'FTS5_UNAVAILABLE',
      'This SQLite WASM build does not include the FTS5 extension, which Gubbins requires for full-text search (spec §2.2.1a). The official @sqlite.org/sqlite-wasm build is expected to bundle it.',
    );
  }

  return {
    sqlite3,
    db,
    sqliteVersion: sqlite3.version.libVersion,
    fts5Available,
    vfs,
    filename: DB_FILENAME,
  };
}

/** Open the live database on whichever VFS {@link resolveVfsTarget} names. */
async function openConnection(sqlite3: Sqlite3Static): Promise<{ db: OpfsDatabase; vfs: string }> {
  if ((await resolveVfsTarget()) === 'sahpool') return openOnSahPool();

  if (!hasPrimaryVfs(sqlite3)) {
    // Only reachable with a database already sitting in the primary VFS, which is exactly when
    // the fallback must *not* be used: opening a pool here would present an empty app and let
    // the user write into a second database, while the real one stays on disk out of reach.
    throw new DbError(
      'OPFS_UNAVAILABLE',
      'Your data is held in this browser’s OPFS storage, which is not reachable right now. That ' +
        'usually means the page is no longer cross-origin isolated (COOP/COEP): reload, and if it ' +
        'persists, check that nothing between you and the site is stripping those headers.',
    );
  }

  try {
    // Flags 'c': open read-write, creating the database file if it does not exist.
    return { db: new sqlite3.oo1.OpfsDb(DB_FILENAME, 'c'), vfs: OPFS_VFS };
  } catch (err) {
    throw DbError.fromUnknown(err, 'OPFS_UNAVAILABLE');
  }
}

/** Open the database on the fallback VFS, mapping every failure onto `OPFS_UNAVAILABLE`. */
async function openOnSahPool(): Promise<{ db: OpfsDatabase; vfs: string }> {
  let pool: SAHPoolUtil;
  try {
    pool = await loadSahPool();
    return { db: new pool.OpfsSAHPoolDb(DB_FILENAME), vfs: pool.vfsName };
  } catch (err) {
    throw DbError.fromUnknown(err, 'OPFS_UNAVAILABLE');
  }
}

/**
 * Whether sqlite-wasm registered the primary OPFS VFS in this worker. It only materialises
 * under cross-origin isolation (COOP/COEP → SharedArrayBuffer), and on WebKit only from Safari
 * 17 — so its absence describes the *environment*, not the build.
 */
function hasPrimaryVfs(sqlite3: Sqlite3Static): boolean {
  return typeof sqlite3.oo1.OpfsDb === 'function';
}

/**
 * Authoritative FTS5 availability check: attempt to create (and drop) a temporary
 * FTS5 virtual table. A `PRAGMA compile_options` scan can miss build nuances; a
 * real CREATE is definitive. Uses the `temp` schema so the persistent DB is never
 * touched (spec §2.2.1a, §1.2).
 */
function probeFts5(db: OpfsDatabase): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__gubbins_fts5_probe USING fts5(content);');
    db.exec('DROP TABLE temp.__gubbins_fts5_probe;');
    return true;
  } catch {
    return false;
  }
}

/** Read a live diagnostics snapshot, including the current schema version. */
export function readDiagnostics(boot: BootstrapResult): DbDiagnostics {
  const userVersion = Number(boot.db.selectValue('PRAGMA user_version') ?? 0);
  return {
    sqliteVersion: boot.sqliteVersion,
    fts5Available: boot.fts5Available,
    vfs: boot.vfs,
    opfs: true,
    userVersion,
    filename: boot.filename,
  };
}
