/**
 * Opt-in **snapshot ingest** — the PWA "push to bridge" (Deferred-work: PWA push to bridge).
 *
 * The bridge normally *reads* `gubbins-sync.json` from a shared folder (the Phase 7 FS-Access
 * sync). For a user who does **not** use FS-Access sync — no shared drive, no NAS mount — this
 * endpoint lets the PWA hand the snapshot straight to the bridge over HTTP: the PWA serialises its
 * whole dataset with the *same* `snapshotToBackupJson(buildLocalSnapshot(...))` it would write to a
 * folder, and POSTs those exact bytes here. The bridge validates them with the **existing**
 * {@link parseBackupJson} version guard and writes them to `GUBBINS_SNAPSHOT_PATH` **atomically**
 * (temp file + `rename`), so the unchanged {@link import('./watcher.ts') watcher} re-hydrates the
 * new snapshot through its normal path. What lands on disk is byte-identical to what the watcher
 * would have read from a synced file, so the read core, `/api/v1`, MCP, and the opt-in writes all
 * see the same data either way.
 *
 * This is **distinct from the §7.3 limited writes** (`write.ts`): a write applies a surgical,
 * per-item change *through* the app's mutation code so it merges via LWW/Delta-CRDT; a push
 * **replaces** the whole snapshot the bridge serves. They are independent opt-ins
 * (`GUBBINS_BRIDGE_ALLOW_PUSH` vs `GUBBINS_BRIDGE_ALLOW_WRITES`).
 *
 * **Read-only-by-construction still holds for the data:** ingest never runs SQL — it only
 * validates JSON and renames a file. The single `parseASTtoSQL` translator is untouched.
 *
 * The body is **streamed to a sibling temp file** as it arrives (bounded by `maxBytes`) rather
 * than buffered whole in memory, so a constrained host (a Pi/NAS on an SD card) can cap the size
 * and an over-large upload is rejected before it is all on disk. Validation then parses the temp
 * file once — the same memory cost the watcher already pays to serve a snapshot of that size —
 * and, only if valid, the temp file is `rename`d over the target (an atomic publish on the same
 * filesystem; the watcher, which filters on the target basename, ignores the differently-named
 * temp file and reacts only to the final rename).
 */
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseBackupJson } from '@/features/sync/backup';
import type { ApiErrorCode } from './api/respond.ts';

/** A successful ingest's summary (echoed to the caller; no inventory data leaks back). */
export interface PushSummary {
  /** The accepted snapshot's `formatVersion`. */
  readonly formatVersion: number;
  /** The accepted snapshot's `generatedAt` (UNIX-ms). */
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
 * Validate a pushed snapshot's text via the app's **own** {@link parseBackupJson} guard, mapping
 * its failures to a {@link PushError}. Pure (no IO) so it is unit-tested directly. A future
 * `formatVersion` is a `422` (well-formed but unprocessable); every other parse/envelope failure is
 * a `400`.
 */
export function validateSnapshotText(text: string): PushSummary {
  let snapshot;
  try {
    snapshot = parseBackupJson(text);
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
  return { formatVersion: snapshot.formatVersion, generatedAt: snapshot.generatedAt };
}

export interface IngestOptions {
  /** The data-source path to (atomically) replace — must be the JSON snapshot path. */
  readonly snapshotPath: string;
  /** The request body bytes (an `IncomingMessage` is an `AsyncIterable<Buffer>`). */
  readonly body: AsyncIterable<Uint8Array>;
  /** Hard cap on the body size in bytes; an over-large body is rejected with a `413`. */
  readonly maxBytes: number;
}

/**
 * Ingest a pushed snapshot end-to-end: stream the body to a sibling temp file (bounded by
 * {@link IngestOptions.maxBytes}), validate it with {@link validateSnapshotText}, then atomically
 * `rename` it over the target. The temp file is always cleaned up on any failure. Returns the
 * accepted snapshot's summary; the watcher picks up the rename and re-hydrates.
 */
export async function ingestSnapshot(options: IngestOptions): Promise<PushSummary> {
  const dir = path.dirname(options.snapshotPath);
  const tmp = path.join(dir, `.${path.basename(options.snapshotPath)}.push-${process.pid}-${Date.now()}.tmp`);

  const handle = await open(tmp, 'w');
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of options.body) {
      total += chunk.byteLength;
      if (total > options.maxBytes) {
        tooLarge = true;
        break;
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  if (tooLarge) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new PushError(
      413,
      'payload_too_large',
      `The snapshot exceeds the maximum push size of ${options.maxBytes} bytes.`,
    );
  }

  let summary: PushSummary;
  try {
    const text = await readFile(tmp, 'utf8');
    summary = validateSnapshotText(text); // throws PushError on a bad/newer snapshot
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  try {
    await rename(tmp, options.snapshotPath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return summary;
}
