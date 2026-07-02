/**
 * SQLite WASM bootstrap (spec §2.2.1, §2.2.1a, §1.2).
 *
 * Instantiates the official @sqlite.org/sqlite-wasm module, opens the database on
 * the **OPFS VFS** (the mandated primary VFS — never IndexedDB/:memory: in
 * production), enables foreign-key enforcement, and performs a hard runtime probe
 * that FTS5 is compiled in. Any missing prerequisite throws a typed DbError so the
 * worker can report it cleanly rather than silently degrading.
 *
 * Runs exclusively inside the database Web Worker (§2.2.2).
 */
import sqlite3InitModule, { type Sqlite3Static, type OpfsDatabase } from '@sqlite.org/sqlite-wasm';
import { DbError } from '../errors';
import type { DbDiagnostics } from '../rpc/protocol';

/** The single database file within the OPFS hierarchy. */
export const DB_FILENAME = '/gubbins.sqlite3';

/** The OPFS VFS name as registered by sqlite-wasm. */
const OPFS_VFS = 'opfs';

export interface BootstrapResult {
  readonly sqlite3: Sqlite3Static;
  readonly db: OpfsDatabase;
  readonly sqliteVersion: string;
  readonly fts5Available: boolean;
  readonly vfs: string;
  readonly filename: string;
}

export async function bootstrapDatabase(): Promise<BootstrapResult> {
  const sqlite3 = await sqlite3InitModule();

  // The OPFS VFS only materialises in a Worker under cross-origin isolation
  // (COOP/COEP → SharedArrayBuffer). Its absence means the environment is
  // mis-configured; we must not fall back to IndexedDB/:memory' (spec §2.2.1).
  if (typeof sqlite3.oo1.OpfsDb !== 'function') {
    throw new DbError(
      'OPFS_UNAVAILABLE',
      'The OPFS VFS is unavailable. Gubbins requires a cross-origin-isolated context (COOP/COEP headers enabling SharedArrayBuffer) running inside a Web Worker.',
    );
  }

  let db: OpfsDatabase;
  try {
    // Flags 'c': open read-write, creating the database file if it does not exist.
    db = new sqlite3.oo1.OpfsDb(DB_FILENAME, 'c');
  } catch (err) {
    throw DbError.fromUnknown(err, 'OPFS_UNAVAILABLE');
  }

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
    vfs: OPFS_VFS,
    filename: DB_FILENAME,
  };
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
