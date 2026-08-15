/**
 * The one main-thread client of the fflate vault worker (issue #695).
 *
 * Export (§4.5), Backup and the weekly Full Archive (§2.7) all package their output with the same
 * {@link ./export-vault.worker}, and each used to carry its own byte-for-byte copy of the round
 * trip. Three copies is three places to fix anything — and the argument order had already drifted
 * between them — so the round trip lives here once.
 *
 * **The wait is bounded (issue #695).** A `postMessage` bridge gives no delivery guarantee: a
 * worker that loads, takes the request and then dies quietly, or one wedged inside fflate on a very
 * large archive, produces no message *and* no `error` event. That is indistinguishable from silence,
 * and an unbounded wait turns it into a promise that never settles — an export that never finishes
 * and never fails, a backup that never completes, a scheduled archive whose promise is never
 * resolved. Each is exactly the operation a user is least willing to walk away from unsure about,
 * and there is nothing on screen to say a reload is the only way out. So every round trip carries a
 * {@link VAULT_ZIP_TIMEOUT_MS} budget and rejects when it expires, which the callers' existing error
 * paths already report. This is the same call `worker-driver.ts` made for the database RPC (#299)
 * and `barcode-decoder.ts` made for a decoded frame (#678).
 *
 * The **latch** half of those two does not apply here, and deliberately so: each call constructs its
 * own worker and terminates it, so there is no long-lived instance to leave in a zombie state.
 *
 * Abandoning a timed-out zip is safe in a way abandoning a database write is not: the worker only
 * computes bytes, so the work it might still finish has nowhere to land — the caller is what
 * downloads or saves the result, and it has already given up. So a breach terminates the worker
 * outright, reclaiming whatever it was holding, rather than leaving it to finish work no one is
 * waiting for.
 */
import type { VaultZipRequest, VaultZipResponse } from './export-vault.worker';

/**
 * How long the vault worker may spend zipping one request before it is abandoned (issue #695).
 *
 * Generous by design, and budgeted like `RPC_TIMEOUT_MS.exportBinary` rather than like a query:
 * these are whole-database operations, so this exists to convert an infinite wait into a reported
 * failure, not to police a slow zip. A false positive on a genuinely large archive is the failure
 * mode worth avoiding.
 *
 * @internal Exported for unit tests only.
 */
export const VAULT_ZIP_TIMEOUT_MS = 300_000;

/**
 * Copy for a zip the worker never answered; authored, so `describeError` shows it as written.
 *
 * One sentence has to serve an export, a backup and the weekly archive, so the remedy names what
 * each of them can actually leave out — "export fewer items" would be advice the Backup dialog
 * offers no control for. It promises only that the **inventory** is unchanged, which is true on
 * every path: the destructive Replace restore reserves its destination file before the zip runs
 * (see `BackupDialog`), so claiming nothing at all was written would overstate it.
 */
export const VAULT_ZIP_TIMEOUT_MESSAGE =
  'Packaging the .zip took too long and was stopped, so no file was created. Your inventory is ' +
  'unchanged, so it is safe to try again — putting less in the file (a smaller scope, or leaving ' +
  'the full-resolution images out) makes it quicker.';

/**
 * Copy for a zip the worker could not produce at all — it failed outright, or would not take the
 * request. Authored, so `describeError` shows it as written rather than the browser's own jargon.
 */
export const VAULT_ZIP_FAILED_MESSAGE =
  'The background task that packages the .zip could not finish it, so no file was created. Your ' +
  'inventory is unchanged — reloading the page and trying again usually clears it.';

/**
 * Zip a text + binary entry map in the fflate vault worker, off the main thread.
 *
 * Resolves with the zip bytes; rejects — always with an `Error` carrying an authored sentence, and
 * the underlying failure as its `cause` — if the worker fails, cannot be given the request, or does
 * not answer within {@link VAULT_ZIP_TIMEOUT_MS}. The worker is terminated whichever way the call
 * settles.
 */
export function zipInVaultWorker(
  files: Record<string, string>,
  assets: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // This exact `new Worker(new URL(...), { type: 'module' })` form is what Vite statically
    // detects to bundle the worker (and its fflate import) as a separate chunk.
    const worker = new Worker(new URL('./export-vault.worker.ts', import.meta.url), {
      type: 'module',
    });

    let settled = false;
    /**
     * Settle once and tear down. The guard matters because a worker can answer *after* its budget
     * expired — the caller has already been told it failed, so the late bytes are dropped rather
     * than resolving a promise that is no longer anyone's.
     */
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      settle();
    };

    // Declared after `finish` only because `finish` is what disarms it; nothing can call `finish`
    // before this line runs, since every path into it is a callback.
    const timer = setTimeout(
      () => finish(() => reject(new Error(VAULT_ZIP_TIMEOUT_MESSAGE))),
      VAULT_ZIP_TIMEOUT_MS,
    );

    worker.onmessage = (event: MessageEvent<VaultZipResponse>) => {
      const { zip } = event.data;
      finish(() => resolve(zip));
    };
    worker.onerror = (err) => {
      // Wrapped rather than passed through: an `ErrorEvent` is not an `Error`, so it reaches the
      // user as the call site's generic fallback and logs as an opaque event. The cause keeps it.
      finish(() => reject(new Error(VAULT_ZIP_FAILED_MESSAGE, { cause: err })));
    };

    const request: VaultZipRequest = { files, assets };
    try {
      worker.postMessage(request);
    } catch (error) {
      // A payload that cannot be structured-cloned never reaches the worker, so nothing will ever
      // answer it. Reject now rather than waiting out the whole budget for a request never sent —
      // and wrapped like the `error` event, because a `DataCloneError` *is* an `Error` whose text
      // reads as authored to `describeError`, so passing it through would put "… could not be
      // cloned" in front of the user as the reason their backup failed.
      finish(() => reject(new Error(VAULT_ZIP_FAILED_MESSAGE, { cause: error })));
    }
  });
}
