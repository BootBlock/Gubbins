/**
 * Reading, replacing and clearing the database **file**, on whichever VFS holds it (issue #255).
 *
 * Under the primary `opfs` VFS the database is a plain OPFS file, so Safe Mode's rescue actions
 * reach it straight from the main thread — deliberately, since the crash screen is exactly where
 * the worker may be the thing that failed. Under the `opfs-sahpool` fallback there is no such
 * file: the pool maps names to opaque handles it alone can resolve, so the same three operations
 * have to run *here*, beside the VFS.
 *
 * Every one of them runs **without opening the database** (the worker dispatches them ahead of
 * `ensureBoot`), because the state they exist to rescue is precisely the one where it cannot be
 * opened. They do require the caller to have closed any live connection first: importing over or
 * wiping a file that is still open is undefined behaviour in the pool.
 */
import { DB_FILENAME } from '../db-file';
import {
  DB_SIDECAR_SUFFIXES,
  deletePlainDatabaseFiles,
  readPlainDatabaseFile,
  writePlainDatabaseFile,
} from '../db-storage';
import { loadSahPool, resolveVfsTarget } from './sqlite-bootstrap';
import type { WriteDatabaseFileResult } from '../rpc/protocol';

/**
 * The raw bytes of the stored database, or `null` when this origin has none.
 *
 * The counterpart to `captureRestorePoint`'s direct OPFS read: a pool database can only be
 * exported through the VFS. `exportFile` reads the file rather than the *database*, so a
 * corrupt one still comes back — which is the whole point of a restore point.
 */
export async function readDatabaseFile(): Promise<Uint8Array | null> {
  if ((await resolveVfsTarget()) === 'sahpool') {
    const pool = await loadSahPool();
    if (!pool.getFileNames().includes(DB_FILENAME)) return null;
    return await pool.exportFile(DB_FILENAME);
  }
  const file = await readPlainDatabaseFile();
  if (!file || file.size === 0) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Replace the stored database with raw SQLite bytes, clearing the previous session's journal.
 *
 * Writes to wherever the *next* boot will look, which on a fresh install is a question only
 * this side can answer — that is why the main thread delegates here rather than always writing
 * the plain file, which the fallback VFS would never read.
 */
export async function writeDatabaseFile(bytes: Uint8Array): Promise<WriteDatabaseFileResult> {
  if ((await resolveVfsTarget()) === 'sahpool') {
    const pool = await loadSahPool();
    // `importDb` overwrites the named file whole and rewrites its header to disable WAL, so the
    // journal state that survives is only ever the pool's own sidecars — drop those and the
    // restored database stands alone. `unlink` reports absence rather than throwing.
    await pool.importDb(DB_FILENAME, bytes);
    for (const suffix of DB_SIDECAR_SUFFIXES) pool.unlink(`${DB_FILENAME}${suffix}`);
    return { staleSidecar: null };
  }
  const { staleSidecar } = await writePlainDatabaseFile(bytes);
  return { staleSidecar };
}

/**
 * Delete the stored database and its sidecars.
 *
 * The authoritative half of the Safe Mode purge on the fallback VFS: the pool's files are held
 * open by this worker, so a main-thread `removeEntry` on its directory can fail outright while
 * the handles are live. `wipeFiles` releases and blanks every slot instead.
 */
export async function wipeDatabaseFiles(): Promise<void> {
  if ((await resolveVfsTarget()) === 'sahpool') {
    const pool = await loadSahPool();
    await pool.wipeFiles();
    return;
  }
  await deletePlainDatabaseFiles();
}
