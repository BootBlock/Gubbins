/**
 * Where the database physically lives — the one answer the worker and the main thread share.
 *
 * Gubbins opens SQLite on one of two OPFS-backed virtual file systems (issue #255):
 *
 *  - **`opfs`** — the primary (spec §2.2.1). The database *is* a plain OPFS file at
 *    {@link DB_FILENAME}, so anything holding a directory handle can read, replace or delete
 *    it. It needs a cross-origin-isolated context and, on WebKit, Safari 17+.
 *  - **`opfs-sahpool`** — the fallback for browsers that cannot register the primary. Its
 *    files live inside {@link SAHPOOL_DIRECTORY} under opaque names the VFS maps internally,
 *    so the database is **not** reachable by name: only the VFS itself can read or write it.
 *
 * Which one an origin uses is decided by **what is already on disk**, never by preference
 * alone — switching would leave a perfectly good database sitting in the other one, invisible
 * and quietly replaced by an empty one. {@link detectDbStorageLayout} is that single rule, and
 * both sides call it so they cannot disagree about where the bytes are.
 *
 * Deliberately imports nothing but {@link DB_FILENAME}: the main thread reaches for these on
 * the crash screen and must never pull the SQLite WASM glue in for the sake of a path
 * (issue #165). Everything here is plain File System Access API.
 */
import { DB_FILENAME } from './db-file';

/** The primary VFS name as registered by sqlite-wasm (spec §2.2.1). */
export const OPFS_VFS = 'opfs';

/** The fallback VFS name as registered by `installOpfsSAHPoolVfs` (issue #255). */
export const SAHPOOL_VFS = 'opfs-sahpool';

/**
 * The OPFS directory the SAHPool VFS keeps its files in.
 *
 * Named for Gubbins rather than left at the library default (`.opfs-sahpool`) so the presence
 * of the directory means *our* pool: the VFS treats every file inside as its own to rewrite or
 * delete, and {@link detectDbStorageLayout} treats it as proof of where this origin's database
 * lives. Neither should ever be decided by a directory some other engine on the same origin
 * created. Changing this name orphans existing pool databases — don't.
 */
export const SAHPOOL_DIRECTORY = '.gubbins-sahpool';

/** {@link DB_FILENAME} without its leading slash — the OPFS entry name. */
export const DB_BASENAME = DB_FILENAME.replace(/^\//, '');

/**
 * The journal/WAL sidecar files SQLite keeps beside the database. Shared so every path that
 * replaces or purges the database can never disagree about what counts as a sidecar.
 */
export const DB_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/**
 * Which store this origin's database lives in — or `none` when it has none yet.
 *
 * `none` is not "no VFS": it means nothing is on disk to be preserved, so the choice is still
 * open and belongs to whichever side can see what the browser supports (the worker).
 */
export type DbStorageLayout = 'opfs' | 'sahpool' | 'none';

/**
 * Decide where this origin's database lives, from the file system alone.
 *
 * A plain file wins over the pool directory: an origin that once ran on the primary VFS keeps
 * running on it, even if a pool was left behind by a spell without isolation. An empty husk of
 * a file does not count — a failed `create` would otherwise pin the origin to a VFS it never
 * managed to use.
 */
export async function detectDbStorageLayout(): Promise<DbStorageLayout> {
  const file = await readPlainDatabaseFile();
  if (file && file.size > 0) return 'opfs';
  return (await hasSahPoolStore()) ? 'sahpool' : 'none';
}

/** True when the SAHPool VFS has a store on this origin (whether or not it holds a database). */
export async function hasSahPoolStore(): Promise<boolean> {
  const root = await opfsRoot();
  if (!root) return false;
  try {
    await root.getDirectoryHandle(SAHPOOL_DIRECTORY);
    return true;
  } catch {
    // Absent, or OPFS refused the lookup — either way there is no pool to read.
    return false;
  }
}

/**
 * The plain-OPFS database file, or `null` when this origin has none (or has no OPFS at all).
 *
 * Only *absence* is benign. Anything else — a locked file, an I/O error — means a database is
 * there and could not be read, so the failure reaches the caller: a restore that swallowed it
 * would overwrite data no copy exists of (issue #198).
 */
export async function readPlainDatabaseFile(): Promise<File | null> {
  const root = await opfsRoot();
  if (!root) return null;
  try {
    const handle = await root.getFileHandle(DB_BASENAME);
    return await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

/** The outcome of {@link writePlainDatabaseFile} — see {@link PlainWriteResult.staleSidecar}. */
export interface PlainWriteResult {
  /**
   * The sidecar that could not be removed *after* the new bytes committed, if any. Reported
   * rather than thrown because the write itself succeeded: the caller must finish its work and
   * then refuse to reload, not unwind a restore that already landed (issue #203).
   */
  readonly staleSidecar: string | null;
  /** Why {@link staleSidecar} could not be removed, for the error the caller raises. */
  readonly cause: unknown;
}

/**
 * Overwrite the plain-OPFS database file with raw SQLite bytes, then clear the previous
 * session's journal sidecars.
 *
 * **Order matters (issue #203).** The write comes *first* and the sidecars go only once it has
 * committed. Deleting them up front discards, before anything has replaced it, the one thing
 * that could repair the current database — a hot rollback journal left by an unclean shutdown —
 * so a write that then fails (quota, a tab closed mid-write, any OPFS error) turns a database
 * that was merely un-updated into one that is unrecoverable. A failed write aborts the writable
 * rather than closing it, so the original file keeps its contents and its sidecars still match it.
 *
 * The caller must have released the database connection beforehand, and must reload afterwards
 * so it is re-opened.
 */
export async function writePlainDatabaseFile(bytes: Uint8Array): Promise<PlainWriteResult> {
  const root = await navigator.storage.getDirectory();

  const handle = await root.getFileHandle(DB_BASENAME, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as BufferSource);
    await writable.close();
  } catch (error) {
    // Discard the staged write instead of committing a partial file. Best-effort: the stream
    // may already be errored, and that must not mask the failure the caller needs to see.
    await writable.abort?.().catch(() => {});
    throw error;
  }

  // Only now the new bytes are on disk: a sidecar from the old session would otherwise be
  // replayed over them. A removal that fails for a reason other than absence is *not*
  // swallowed — the database has been replaced but a stale journal survives beside it, which
  // the caller must surface rather than reload into.
  for (const name of DB_SIDECAR_SUFFIXES.map((suffix) => `${DB_BASENAME}${suffix}`)) {
    try {
      await root.removeEntry(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') continue;
      return { staleSidecar: name, cause: error };
    }
  }
  return { staleSidecar: null, cause: undefined };
}

/**
 * Delete the plain-OPFS database and its sidecars, best-effort.
 *
 * Every entry is attempted independently: this backs the last-resort purge, which must make
 * progress on every front rather than stop at the first thing that was not there.
 */
export async function deletePlainDatabaseFiles(): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  for (const suffix of ['', ...DB_SIDECAR_SUFFIXES]) {
    try {
      await root.removeEntry(`${DB_BASENAME}${suffix}`);
    } catch {
      // Not present, or held open — the caller has other passes at it.
    }
  }
}

/** Delete the SAHPool store outright, best-effort — every file in it belongs to the VFS. */
export async function deleteSahPoolStore(): Promise<void> {
  const root = await opfsRoot();
  if (!root) return;
  try {
    await root.removeEntry(SAHPOOL_DIRECTORY, { recursive: true });
  } catch {
    // Absent, or a sync access handle is still open on one of its files — the worker-side
    // wipe is the authoritative half of the purge; this is the backstop.
  }
}

/** The OPFS root, or `null` where OPFS is unavailable (private mode, blocked site data). */
async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}
