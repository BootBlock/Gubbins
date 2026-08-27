/**
 * Shared snapshot IO for the bridge's two mutating surfaces — §7.3 limited writes (`write.ts`)
 * and snapshot ingest (`push.ts`).
 *
 * Both perform a **read-modify-write** on the same on-disk snapshot, so they share two
 * guarantees that must not be re-implemented (and quietly diverge) in each:
 *
 *   1. **Atomic publish** — write a sibling temp file, then `rename` it over the target, so a
 *      reader (the PWA's `fetchSnapshot`, or the bridge's own directory watcher) never observes
 *      a half-written file.
 *   2. **Serialisation across *both* surfaces** — a single-flight queue every mutation passes
 *      through. Writes were already serialised against each other; once a push also merges
 *      (rather than blindly replacing) it, too, reads the current state and writes a new one, so
 *      a write and a push that both read the pre-change state would otherwise silently drop one
 *      of the two changes. One shared {@link SnapshotMutex}, created once at the composition root
 *      and handed to both, closes that gap.
 *   3. **A precondition on the publish** — a mutex only binds writers *inside one process*, and
 *      the snapshot has writers the bridge cannot enrol in one: the MCP stdio server is a separate
 *      OS process, and in the folder-sync deployment the PWA writes the same file directly. So
 *      every read records a {@link SnapshotStamp} of the file it read, and the publish
 *      ({@link writeSnapshotAtomicIf} / {@link renameSnapshotIf}) refuses when the file no longer
 *      carries that stamp. The caller re-reads and re-applies instead of overwriting a change it
 *      never saw (issue #549).
 *
 * The precondition is a **narrowing**, not a true compare-and-swap: POSIX offers no atomic
 * "rename only if unchanged", so the stat and the rename are still two calls. What it removes is
 * the part of the window that actually matters — hydrating a real inventory runs the migration
 * engine and a full restore, so the read→publish gap is *seconds*; the check→rename gap that
 * remains is a single stat apart. A loser is turned into a retry rather than a silent loss.
 */
import { open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A single-flight queue. Every mutation of the served snapshot runs through one shared instance,
 * so a write and a push apply strictly one-at-a-time and each sees the previous one's result.
 */
export interface SnapshotMutex {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Build a {@link SnapshotMutex}. Tasks run in submission order on a promise chain: each waits for
 * the previous to settle — whatever its outcome — before it starts, so no two overlap. The tail is
 * kept from ever rejecting, so one failed task cannot break the chain for those queued behind it.
 */
export function createSnapshotMutex(): SnapshotMutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** Monotonic suffix so two temp siblings created in the same millisecond cannot collide. */
let tempCounter = 0;

/**
 * A sibling temp path for `targetPath`, unique within this process even for two calls in the same
 * millisecond (the pid + timestamp alone are not — two concurrent pushes stream in parallel). The
 * leading `.` and distinct basename keep the watcher, which filters on the target basename, from
 * reacting to it.
 */
export function tempSiblingPath(targetPath: string, tag: string): string {
  const dir = path.dirname(targetPath);
  tempCounter = (tempCounter + 1) % Number.MAX_SAFE_INTEGER;
  return path.join(
    dir,
    `.${path.basename(targetPath)}.${tag}-${process.pid}-${Date.now()}-${tempCounter}.tmp`,
  );
}

/**
 * The identity of one on-disk snapshot, captured when it was read, so a later publish can tell
 * "still the file I read" from "someone replaced it while I worked".
 *
 * Three cheap fields rather than a content hash: hashing would mean re-reading the whole file at
 * publish time, on the lock, to answer a question a `stat` already answers well. Each field closes
 * a gap the others leave:
 *
 * - `mtimeMs` — the obvious signal, but its resolution is filesystem-dependent (one or two seconds
 *   on some), so on its own two rapid publishes can look identical.
 * - `size` — separates same-tick writes that changed the byte count, which most do.
 * - `ino` — every publish is a `rename` of a *new* temp file over the target, so the inode changes
 *   even when the bytes and the timestamp do not. Node reports `0` for it on some platforms; a
 *   constant `0` compares equal and simply contributes nothing, so it can never cause a false
 *   conflict.
 */
export interface SnapshotStamp {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

/**
 * Thrown when a publish's precondition fails: the snapshot on disk is no longer the one the caller
 * read, so writing would discard whatever replaced it. The caller retries from the read.
 */
export class SnapshotConflictError extends Error {
  override readonly name = 'SnapshotConflictError';
}

/**
 * Read the snapshot and stamp it in one shot, through a single file handle. The stamp comes from
 * `fstat` on that handle, so it describes exactly the bytes that were read — a `stat` of the
 * *path* either side of the read could describe a different file.
 */
export async function readSnapshotWithStamp(
  snapshotPath: string,
): Promise<{ text: string; stamp: SnapshotStamp }> {
  const handle = await open(snapshotPath, 'r');
  try {
    const text = await handle.readFile('utf8');
    return { text, stamp: toStamp(await handle.stat()) };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Stamp the snapshot without reading it. `null` means "no file there" — a legitimate state (the
 * first push publishes into an empty folder), and one the precondition can require just as it
 * requires a particular stamp.
 *
 * Only a *missing* path answers `null`; every other failure is rethrown. Collapsing the two would
 * be the precondition's own back door: the first-push publish requires `null`, so a permission or
 * IO failure reported as "absent" would let the pushed body be renamed over a snapshot that is
 * present and merely unreadable at that instant — the exact loss the check exists to stop.
 */
export async function statSnapshot(snapshotPath: string): Promise<SnapshotStamp | null> {
  try {
    return toStamp(await stat(snapshotPath));
  } catch (err) {
    if (isMissingPath(err)) return null;
    throw err;
  }
}

/** Whether a filesystem error means "nothing is at that path", as opposed to "could not look". */
function isMissingPath(err: unknown): boolean {
  return errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR';
}

/**
 * Whether a failed `rename` was a sharing violation rather than a settled refusal — someone else
 * had the target open at that instant.
 *
 * This is Windows in particular: Node opens a file without `FILE_SHARE_DELETE`, so a `rename` over
 * a path another process is *reading* fails `EPERM`. The bridge's own snapshot is read constantly
 * (the watcher re-hydrates it, a second bridge process reads it, the app syncs it), and a
 * precondition that retries makes those renames more frequent rather than less, so the case is
 * expected rather than exotic. Retrying is right: nothing was published, so the caller re-reads
 * and re-applies exactly as it does after a lost precondition. A genuinely permanent refusal — a
 * read-only folder — simply exhausts the attempts and lands as a `409` naming the file it could
 * not replace, which says more than an opaque `500` would.
 */
function isSharingViolation(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

/** Whether two stamps describe the same file. Both `null` (still absent) counts as unchanged. */
export function stampsMatch(a: SnapshotStamp | null, b: SnapshotStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

function toStamp(stats: { mtimeMs: number; size: number; ino: number }): SnapshotStamp {
  return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
}

/**
 * Write `text` to `snapshotPath` atomically, but only while the file still carries `expected`.
 * The temp file is written first (the slow part, off the precondition), then the check and the
 * rename run back-to-back so as little as possible can happen between them.
 *
 * Throws {@link SnapshotConflictError} — leaving the target untouched — when the stamp has moved.
 */
export async function writeSnapshotAtomicIf(
  snapshotPath: string,
  text: string,
  expected: SnapshotStamp | null,
): Promise<void> {
  const tmp = tempSiblingPath(snapshotPath, 'bridge');
  try {
    await writeFile(tmp, text, 'utf8');
    await renameSnapshotIf(tmp, snapshotPath, expected);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Publish an already-written temp file over `snapshotPath`, but only while the target still
 * carries `expected`. Split from {@link writeSnapshotAtomicIf} because the push path streams the
 * incoming body to its own temp and publishes *those* bytes verbatim; on a conflict the temp is
 * deliberately left in place so the caller can retry without re-uploading.
 */
export async function renameSnapshotIf(
  tempPath: string,
  snapshotPath: string,
  expected: SnapshotStamp | null,
): Promise<void> {
  let actual: SnapshotStamp | null;
  try {
    actual = await statSnapshot(snapshotPath);
  } catch {
    // The check itself failed, so the file's state is unknown — which is not permission to
    // overwrite it. Reported as a conflict so the caller retries and then gives up with a `409`,
    // rather than as an opaque `500`. The cause is deliberately not quoted: it would carry the
    // snapshot's path back to the caller.
    throw new SnapshotConflictError('The inventory snapshot could not be checked before publishing.');
  }
  if (!stampsMatch(actual, expected)) {
    throw new SnapshotConflictError('The inventory snapshot changed while this change was being applied.');
  }
  try {
    await rename(tempPath, snapshotPath);
  } catch (err) {
    if (!isSharingViolation(err)) throw err;
    throw new SnapshotConflictError('The inventory snapshot was in use and could not be replaced.');
  }
}

/**
 * How many times a mutation re-reads and re-applies after losing a precondition before it gives
 * up. Each attempt costs a full hydrate, so this is a handful of genuine collisions rather than a
 * spin: a caller that loses three in a row is contending with a writer that is not going to stop,
 * and a `409` telling it to try later is more honest than a fourth silent retry.
 */
export const SNAPSHOT_PUBLISH_ATTEMPTS = 3;
