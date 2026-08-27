/**
 * Opt-in **snapshot ingest** — the PWA "push to bridge" (Deferred-work: PWA push to bridge).
 *
 * The bridge normally *reads* `gubbins-sync.json` from a shared folder (the Phase 7 FS-Access
 * sync). For a user who does **not** use FS-Access sync — no shared drive, no NAS mount — this
 * endpoint lets the PWA hand the snapshot straight to the bridge over HTTP: the PWA serialises its
 * whole dataset with the *same* `snapshotToBackupJson(buildLocalSnapshot(...))` it would write to a
 * folder, and POSTs those exact bytes here.
 *
 * The bridge does **not** blindly replace the served snapshot with the incoming one. That would
 * silently destroy any change the bridge itself made in the meantime — an opt-in §7.3 write (a
 * Home Assistant automation decrementing stock), or an earlier push from another device — because
 * the pushing device's copy has no knowledge of it (issue #154). Instead a push is treated as a
 * **sync peer** and **merged** into the served snapshot through the app's *own* §7.3 reconcile —
 * the identical LWW / Delta-CRDT path the {@link import('./write.ts') writes} already rely on. The
 * served state is `local` (a bridge change that beat the push is newer and survives), the pushed
 * device is `remote` (its genuinely newer edits win), and the merged result is written back
 * **atomically** so the unchanged {@link import('./watcher.ts') watcher} re-hydrates it. Only when
 * there is nothing mergeable — no snapshot on disk yet (first push), or an unreadable/corrupt one —
 * is the incoming snapshot placed verbatim.
 *
 * This shares the merge machinery with the §7.3 limited writes (`write.ts`) and the same shared
 * single-flight ({@link import('./snapshot-io.ts').SnapshotMutex}), so a push and a write can never
 * read the same pre-change state and clobber one another. They remain independent opt-ins
 * (`GUBBINS_BRIDGE_ALLOW_PUSH` vs `GUBBINS_BRIDGE_ALLOW_WRITES`). Because that single-flight
 * reaches no further than this process — the MCP server is a second one, and under folder sync the
 * PWA writes the file itself — the publish additionally requires the snapshot to still be the one
 * that was merged into, and a push that loses that race re-merges rather than overwriting
 * (issue #549).
 *
 * **Read-only-by-construction still holds for the caller's data:** ingest never runs caller SQL —
 * it validates JSON and merges through the app's own reconcile/apply. The single `parseASTtoSQL`
 * translator is untouched.
 *
 * The body is **streamed to a sibling temp file** as it arrives (bounded by `maxBytes`) rather than
 * buffered whole in memory, so a constrained host (a Pi/NAS on an SD card) can cap the size and an
 * over-large upload is rejected before it is all on disk. The stream and the validation run
 * lock-free — only the merge-and-publish step holds the shared lock, so a large upload does not
 * stall every write for its whole duration.
 */
import { open, readFile, rm } from 'node:fs/promises';
import { parseBackupJson, snapshotToBackupJson } from '@/features/sync/backup';
import { mergeSnapshot } from '@/features/sync/merge';
import type { SyncSnapshot } from '@/features/sync/types';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { errorMessage } from './errors.ts';
import { hydrateFromJson } from './hydrate.ts';
import {
  createSnapshotMutex,
  readSnapshotWithStamp,
  renameSnapshotIf,
  SnapshotConflictError,
  SNAPSHOT_PUBLISH_ATTEMPTS,
  tempSiblingPath,
  writeSnapshotAtomicIf,
  type SnapshotMutex,
  type SnapshotStamp,
} from './snapshot-io.ts';
import type { ApiErrorCode } from './api/respond.ts';

/** A successful ingest's summary (echoed to the caller; no inventory data leaks back). */
export interface PushSummary {
  /** The served snapshot's `formatVersion` after the push. */
  readonly formatVersion: number;
  /** The served snapshot's `generatedAt` after the push (UNIX-ms; the merge instant when merged). */
  readonly generatedAt: number;
}

/**
 * An ingest failure carrying the HTTP status + v1 error code the transport should surface. A
 * malformed/non-JSON body is a `400` `bad_request`; a snapshot from a *newer* PWA build is a `422`
 * `unprocessable` (well-formed but unsupported — the {@link parseBackupJson} version guard); an
 * over-large body is a `413` `payload_too_large`. Anything unexpected propagates and collapses to
 * a generic 500 in the server's outer handler.
 *
 * (Explicit field assignment — Node's strip-only TypeScript mode rejects constructor *parameter
 * properties*, which `tsc` would otherwise accept; mirrors {@link import('./write.ts').WriteError}.)
 */
export class PushError extends Error {
  override readonly name = 'PushError';
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Parse a pushed snapshot's text via the app's **own** {@link parseBackupJson} guard, mapping its
 * failures to a {@link PushError}. A future `formatVersion` is a `422` (well-formed but
 * unprocessable); every other parse/envelope failure is a `400`.
 */
function parseIncomingSnapshot(text: string): SyncSnapshot {
  try {
    return parseBackupJson(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The snapshot could not be read.';
    // parseBackupJson is the single source of the version-guard message (backup.ts); a snapshot
    // from a newer build is well-formed but unprocessable (422) — anything else is a bad request.
    const isFutureVersion = message.includes('newer version of Gubbins');
    throw new PushError(
      isFutureVersion ? 422 : 400,
      isFutureVersion ? 'unprocessable' : 'bad_request',
      message,
    );
  }
}

/**
 * Validate a pushed snapshot's text and report its envelope. Pure (no IO) so it is unit-tested
 * directly; the ingest path parses the same way to obtain the snapshot it merges.
 */
export function validateSnapshotText(text: string): PushSummary {
  const snapshot = parseIncomingSnapshot(text);
  return { formatVersion: snapshot.formatVersion, generatedAt: snapshot.generatedAt };
}

export interface IngestOptions {
  /** The data-source path to (atomically) update — must be the JSON snapshot path. */
  readonly snapshotPath: string;
  /** The request body bytes (an `IncomingMessage` is an `AsyncIterable<Buffer>`). */
  readonly body: AsyncIterable<Uint8Array>;
  /** Hard cap on the body size in bytes; an over-large body is rejected with a `413`. */
  readonly maxBytes: number;
  /**
   * The single-flight shared with the §7.3 writes, so a push and a write never read the same
   * pre-change state and clobber one another. Defaults to a private one (tests / a lone push).
   */
  readonly mutex?: SnapshotMutex;
  /** The merge's effective clock — the merged snapshot's `generatedAt`. Injected in tests. */
  readonly now?: () => number;
}

/**
 * Ingest a pushed snapshot end-to-end: stream the body to a sibling temp file (bounded by
 * {@link IngestOptions.maxBytes}), validate it, then — under the shared lock — merge it into the
 * served snapshot (or place it verbatim when there is nothing mergeable) and write the result
 * atomically. The temp file is always cleaned up. Returns the served snapshot's summary; the
 * watcher picks up the change and re-hydrates.
 */
export async function ingestSnapshot(options: IngestOptions): Promise<PushSummary> {
  const mutex = options.mutex ?? createSnapshotMutex();
  const now = options.now ?? Date.now;

  // Everything hangs off one temp file; the finally removes it on EVERY exit — a size-cap
  // rejection, a parse error, an aborted/failed upload mid-stream, or a clean publish (the merge
  // path leaves it behind; the replace path renames it away, and force + catch makes the redundant
  // remove a no-op). So a dropped connection can't strand a `.tmp` on a constrained host.
  const tmp = tempSiblingPath(options.snapshotPath, 'push');
  try {
    // Stream (lock-free) to the temp, bounded — an over-large upload is rejected before it is all
    // on disk, and a long upload does not hold the lock and stall every write for its duration.
    await streamBodyToTemp(options.body, tmp, options.maxBytes); // throws PushError(413)

    // Validate + parse the incoming snapshot (pure; lock-free). A bad/newer snapshot is rejected
    // here, before the served file is touched at all.
    const incoming = parseIncomingSnapshot(await readFile(tmp, 'utf8'));

    // Publish under the shared lock: merge into the served snapshot so a concurrent write is never
    // silently discarded (issue #154). The lock binds only writers in this process, so the publish
    // also carries a precondition on the file it merged into, and a lost race re-merges against
    // whatever replaced it rather than overwriting it (issue #549).
    return await mutex.runExclusive(async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await publishIncoming(options.snapshotPath, tmp, incoming, now);
        } catch (err) {
          if (!(err instanceof SnapshotConflictError)) throw err;
          if (attempt >= SNAPSHOT_PUBLISH_ATTEMPTS) {
            throw new PushError(
              409,
              'conflict',
              'The inventory changed, or was in use, while this snapshot was being merged. Try again.',
            );
          }
        }
      }
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Stream the request body to `tmp`, rejecting once it exceeds `maxBytes`. The caller owns the
 * temp's lifetime (it removes it on every exit), so this only enforces the cap and never cleans up.
 */
async function streamBodyToTemp(
  body: AsyncIterable<Uint8Array>,
  tmp: string,
  maxBytes: number,
): Promise<void> {
  const handle = await open(tmp, 'w');
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        break;
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  if (tooLarge) {
    throw new PushError(
      413,
      'payload_too_large',
      `The snapshot exceeds the maximum push size of ${maxBytes} bytes.`,
    );
  }
}

/**
 * Merge the (already-validated) `incoming` snapshot into the served one and publish it atomically,
 * or place it verbatim when there is nothing to merge into. Runs under the shared lock.
 */
async function publishIncoming(
  snapshotPath: string,
  tmp: string,
  incoming: SyncSnapshot,
  now: () => number,
): Promise<PushSummary> {
  let existing: string;
  let stamp: SnapshotStamp | null;
  try {
    ({ text: existing, stamp } = await readSnapshotWithStamp(snapshotPath));
  } catch {
    // No snapshot on disk yet (first push) — nothing to merge, so publish the pushed bytes verbatim
    // (an atomic rename of the temp we already streamed), but only while the folder is still empty.
    // If a snapshot appeared in between there IS something to merge, and the retry does so. The
    // temp survives a refused rename, so the retry never needs the body uploaded again.
    await renameSnapshotIf(tmp, snapshotPath, null);
    return { formatVersion: incoming.formatVersion, generatedAt: incoming.generatedAt };
  }

  let driver: IDatabaseDriver;
  try {
    ({ driver } = await hydrateFromJson(existing));
  } catch (err) {
    // The served snapshot is unreadable/corrupt — there is nothing mergeable to preserve, so a
    // replace is the only option (and cannot lose a write it could never have read). Surface it so
    // a genuine corruption is visible rather than silently overwritten. Still conditional: if the
    // corrupt bytes were a half-written file that has since been republished intact, the retry
    // merges into the good one instead of discarding it.
    console.warn(
      `Push: the existing snapshot could not be read to merge into (${errorMessage(err)}); ` +
        'replacing it with the pushed snapshot.',
    );
    await renameSnapshotIf(tmp, snapshotPath, stamp);
    return { formatVersion: incoming.formatVersion, generatedAt: incoming.generatedAt };
  }

  try {
    // Treat the push as a sync peer and merge it in via the app's OWN §7.3 reconcile — the same
    // path the writes rely on. `local` is the served state (a bridge write that beat this push is
    // newer, so it survives LWW / the Delta-CRDT replay); `remote` is the pushed device (its
    // genuinely newer edits win). offset 0: both snapshots carry absolute timestamps and there is
    // no clock handshake, so they compare at face value.
    const outcome = await mergeSnapshot(driver, {
      mode: 'delta',
      remote: incoming,
      offset: 0,
      effectiveNow: now(),
      lastSyncTimestamp: 0, // unused on the delta path (only the §7.2 clone salvage reads it)
      historyPrunedBefore: 0,
      forceTies: false,
    });
    await writeSnapshotAtomicIf(snapshotPath, snapshotToBackupJson(outcome.merged), stamp);
    return { formatVersion: outcome.merged.formatVersion, generatedAt: outcome.merged.generatedAt };
  } finally {
    await safeClose(driver);
  }
}

async function safeClose(driver: IDatabaseDriver): Promise<void> {
  try {
    await driver.close();
  } catch {
    // The merge driver is discarded after each push; a failed close must not mask the result.
  }
}
