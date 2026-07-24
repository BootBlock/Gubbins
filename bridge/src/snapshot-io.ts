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
 */
import { rename, rm, writeFile } from 'node:fs/promises';
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
 * Write `text` to `snapshotPath` atomically: write a sibling temp file, then `rename` it over the
 * target (an atomic replace on the same filesystem). A reader therefore never observes a
 * half-written file, and the watcher ignores the differently-named temp and reacts only to the
 * final rename.
 */
export async function writeSnapshotAtomic(snapshotPath: string, text: string): Promise<void> {
  const tmp = tempSiblingPath(snapshotPath, 'bridge');
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, snapshotPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
