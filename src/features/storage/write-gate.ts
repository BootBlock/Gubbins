/**
 * The storage Hard Stop for write paths that never touch a repository (spec §7.6.1, issue #200).
 *
 * `BaseRepository.assertWritable()` gates every write that goes through a repository, and
 * `./sync-engine` runs its own §7.4 pre-flight check over a fresh estimate before a sync pass.
 * Between them sit the bulk paths that do neither: a snapshot restore and a catalog import
 * build their statements themselves and hand them straight to `driver.transaction(...)`. Those
 * are among the largest writes the app performs, and the tier the repository guard consults may
 * be minutes old — old enough for the import that is running to have filled the disk itself.
 *
 * The gate is **registered**, not imported, for two reasons:
 *
 *  - `features/sync/snapshot.ts` is also imported by the Bridge, which runs under Node with no
 *    `navigator.storage`, no OPFS quota and no Zustand stores. An unregistered gate is a no-op,
 *    so the Bridge keeps working unchanged and never pulls a browser dependency in through
 *    this seam.
 *  - It keeps the check asynchronous at the call site, which is what lets the production gate
 *    *re-measure* usage before a bulk write rather than trusting a stale tier (see
 *    `storageWriteGate` in `useStorageStore`).
 *
 * Deletions and wipe-then-clone recovery paths deliberately do **not** call this: the Hard Stop
 * exists to stop growth, and blocking the routes that free space would trap a full device.
 */
import { DbError } from '@/db/errors';

/**
 * Resolves when the write may proceed; rejects with a `WRITE_SUSPENDED` {@link DbError} when
 * storage is at the locked tier. Implementations may re-measure usage before deciding.
 */
export type StorageWriteGate = () => Promise<void>;

let gate: StorageWriteGate | null = null;

/**
 * Install the production gate (the app does this once at boot). Passing `null` removes it,
 * which is what tests and the Bridge run with — writes then proceed unchecked, exactly as
 * they did before this seam existed.
 */
export function setStorageWriteGate(next: StorageWriteGate | null): void {
  gate = next;
}

/** Refuse a storage-growing bulk write at the locked tier. A no-op when no gate is installed. */
export async function ensureStorageWritable(): Promise<void> {
  await gate?.();
}

/** The single `WRITE_SUSPENDED` error, so every gate reports the Hard Stop identically. */
export function writeSuspendedError(): DbError {
  return new DbError(
    'WRITE_SUSPENDED',
    'Storage is full (Hard Stop): new writes are suspended. Delete items or free space to continue.',
  );
}
