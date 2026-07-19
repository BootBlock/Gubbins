/**
 * Debounced, atomic snapshot watcher (Phase HA-3).
 *
 * Watches the synced `gubbins-sync.json` and re-hydrates the headless database whenever
 * the PWA writes a new snapshot, so a long-running bridge always answers from fresh
 * data without a restart. Two properties matter:
 *
 *   - **Atomic swap.** A reload builds a *complete* new driver first, then swaps it in,
 *     then closes the old one. A query is therefore never served from a half-loaded DB:
 *     {@link getState} returns either the previous good driver or the fully-built new one.
 *   - **Resilient to mid-write churn.** Snapshots are written non-atomically and may be
 *     briefly absent or partial; the directory watch is debounced, and a hydrate that
 *     fails (file absent, JSON incomplete) keeps the last good state and waits for the
 *     next event rather than tearing the server down.
 *
 * It watches the **containing directory** (filtering on the file's basename) rather than
 * the file inode, so an atomic rename-replace — the safe way to publish a file — is still
 * observed (a direct `fs.watch` on the file can go deaf after the inode is replaced).
 */
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { hydrateFromFile } from './hydrate.ts';
import { HEALTHY_RELOAD, type SnapshotReloadHealth } from './snapshot-health.ts';
import type { BridgeServerState } from './server.ts';

/** Quiet-period after the last filesystem event before a re-hydrate is attempted. */
export const DEFAULT_DEBOUNCE_MS = 200;

export interface SnapshotWatcherOptions {
  /** Path to the snapshot file to watch and hydrate. */
  readonly snapshotPath: string;
  /** Debounce window in ms (defaults to {@link DEFAULT_DEBOUNCE_MS}). */
  readonly debounceMs?: number;
  /**
   * Called after each successful swap with the new state. It is **awaited** before the reload
   * completes, so a post-swap consumer (the EI-1 event pipeline) always reads the just-built
   * driver while it is still live — the next reload cannot close it until this resolves. It
   * must not reject (the pipeline swallows its own errors); a rejection is surfaced via
   * {@link onError} and does not corrupt the already-swapped good state.
   */
  readonly onReload?: (state: BridgeServerState) => void | Promise<void>;
  /** Called when a (re-)hydrate fails; the previous good state is retained. */
  readonly onError?: (error: Error) => void;
}

export interface SnapshotWatcher {
  /** Hydrate once (best-effort) and begin watching. Resolves once watching has started. */
  start(): Promise<void>;
  /** Force an immediate re-hydrate + atomic swap (also used internally by the debounce). */
  reload(): Promise<void>;
  /** The current state, or null until the first successful hydrate. */
  getState(): BridgeServerState | null;
  /**
   * How the recent reloads went. A failed reload keeps the last good state live, so this tally is
   * the only way a caller can tell that {@link getState} is answering from a snapshot known to be
   * out of date — `/health` reports it (issue #312).
   */
  getReloadHealth(): SnapshotReloadHealth;
  /** Stop watching and close the current driver. */
  stop(): Promise<void>;
}

/** Create a snapshot watcher over `snapshotPath`. Call {@link SnapshotWatcher.start}. */
export function createSnapshotWatcher(options: SnapshotWatcherOptions): SnapshotWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const absPath = path.resolve(options.snapshotPath);
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);

  let state: BridgeServerState | null = null;
  let health: SnapshotReloadHealth = HEALTHY_RELOAD;
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  // Serialise reloads: if events arrive while one is in flight, coalesce into a single
  // follow-up so we always converge on the latest on-disk content.
  let reloading = false;
  let reloadQueued = false;

  async function reload(): Promise<void> {
    if (reloading) {
      reloadQueued = true;
      return;
    }
    reloading = true;
    // Only a failure to *load* means the served data is out of date; a post-swap hook that
    // rejects still leaves a fresh snapshot live, so it must not mark the snapshot stale.
    let swapped = false;
    try {
      // Build the new driver to completion BEFORE swapping — atomicity.
      const { driver, snapshot } = await hydrateFromFile(absPath);
      const previous = state;
      state = { driver, snapshotGeneratedAt: toIso(snapshot.generatedAt) };
      swapped = true;
      health = { consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: nowIso() };
      if (previous) await safeClose(previous.driver);
      // Awaited: a post-swap consumer reads `driver` here while it is guaranteed live (the
      // next reload only closes it once this reload — and thus this hook — has completed).
      await options.onReload?.(state);
    } catch (error) {
      // File briefly absent / partial write / bad JSON: keep the last good state, and count the
      // failure so `/health` can stop claiming to be serving current data (issue #312).
      const failure = asError(error);
      if (!swapped) {
        health = {
          consecutiveFailures: health.consecutiveFailures + 1,
          lastError: failure.message,
          lastErrorAt: nowIso(),
          lastSuccessAt: health.lastSuccessAt,
        };
      }
      options.onError?.(failure);
    } finally {
      reloading = false;
      if (reloadQueued) {
        reloadQueued = false;
        await reload();
      }
    }
  }

  function schedule(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void reload();
    }, debounceMs);
  }

  return {
    async start(): Promise<void> {
      // Best-effort initial load: a missing file at boot is not fatal — the server
      // answers 503 until the first snapshot appears and the watcher picks it up.
      await reload();
      watcher = watch(dir, (_event, filename) => {
        // `filename` is null on some platforms; when present, ignore siblings.
        if (filename !== null && filename !== base) return;
        schedule();
      });
    },

    reload,

    getState(): BridgeServerState | null {
      return state;
    },

    getReloadHealth(): SnapshotReloadHealth {
      return health;
    },

    async stop(): Promise<void> {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
      watcher = null;
      if (state) {
        await safeClose(state.driver);
        state = null;
      }
    },
  };
}

/** Close a driver, swallowing errors (a failed close must not mask the swap). */
async function safeClose(driver: BridgeServerState['driver']): Promise<void> {
  try {
    await driver.close();
  } catch {
    // The old driver is being discarded anyway.
  }
}

/** Convert the snapshot's epoch-ms `generatedAt` to ISO-8601, or null if unparseable. */
function toIso(generatedAt: number): string | null {
  const date = new Date(generatedAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Wall-clock stamp for a reload outcome, in the same ISO-8601 shape as `snapshotGeneratedAt`. */
function nowIso(): string {
  return new Date().toISOString();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
