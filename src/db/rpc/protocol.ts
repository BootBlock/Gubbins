/**
 * The strongly typed RPC protocol spoken across the worker bridge (spec §2.2.3).
 *
 * Every call from the main thread is wrapped in an envelope carrying a correlation
 * `id`; the worker replies with the matching `id` and either a result or a
 * serialised error. This is a hand-rolled, promise-based postMessage wrapper —
 * chosen over Comlink to keep the bundle lean (§2.4.3) and the test-time mock
 * trivial (§8.5.3). Messages are structured-clone-safe (no functions/classes).
 */
import { isSerializedDbError, type SerializedDbError } from '../errors';
import type { SqlParams, SqlStatement, SqlRow, SqlExecuteResult } from './driver';
import type { SnapshotMergeRequest, SnapshotMergeResult } from '@/features/sync/merge';

/** Snapshot of the live database/VFS state, returned by `init` and `diagnostics`. */
export interface DbDiagnostics {
  readonly sqliteVersion: string;
  /** Whether the FTS5 extension is compiled in — verified at boot (spec §2.2.1a). */
  readonly fts5Available: boolean;
  /** The active Virtual File System name (expected: an OPFS VFS). */
  readonly vfs: string;
  /** Whether the connection is actually backed by OPFS (not :memory:). */
  readonly opfs: boolean;
  /** Current schema version from `PRAGMA user_version` (spec §2.3.1). */
  readonly userVersion: number;
  /** The database filename/path in the VFS. */
  readonly filename: string;
}

/** The outcome of `writeDatabaseFile` — replacing the stored database (issue #255). */
export interface WriteDatabaseFileResult {
  /**
   * The journal sidecar that could not be removed *after* the new bytes committed, if any.
   * Reported rather than thrown because the write itself succeeded: the caller finishes its
   * work and then refuses to reload, instead of unwinding a restore that already landed (#203).
   */
  readonly staleSidecar: string | null;
}

/** The request union — every supported worker operation. */
export type DbRequest =
  | { readonly kind: 'init' }
  | { readonly kind: 'diagnostics' }
  | { readonly kind: 'exportBinary' }
  | { readonly kind: 'query'; readonly sql: string; readonly params?: SqlParams }
  | { readonly kind: 'execute'; readonly sql: string; readonly params?: SqlParams }
  | { readonly kind: 'transaction'; readonly statements: readonly SqlStatement[] }
  | { readonly kind: 'verifyBinary'; readonly bytes: Uint8Array }
  /**
   * Issue #255: read, replace or clear the stored database *file* without opening it. Only the
   * worker can do this on the `opfs-sahpool` fallback VFS, whose files are not reachable by
   * name through OPFS — and only the worker knows which VFS a fresh install will boot into.
   */
  | { readonly kind: 'readDatabaseFile' }
  | { readonly kind: 'writeDatabaseFile'; readonly bytes: Uint8Array }
  | { readonly kind: 'wipeDatabaseFiles' }
  /**
   * Issue #173: run a whole sync merge in the worker — read the local snapshot, reconcile it
   * against the remote, apply the plan, and return the merged snapshot to push. A coarser
   * operation than the rest of this protocol by design: the alternative is the main thread
   * materialising the entire database as one object and reconciling it synchronously, which
   * freezes the UI for the duration at any real inventory size.
   */
  | { readonly kind: 'snapshotMerge'; readonly request: SnapshotMergeRequest }
  | { readonly kind: 'close' };

/** The outcome of `verifyBinary` — an integrity check of candidate database bytes (issue #198). */
export interface VerifyBinaryResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Maps each request kind to its successful result type (documentation + driver casts). */
export interface DbResultMap {
  readonly init: DbDiagnostics;
  readonly diagnostics: DbDiagnostics;
  /** Raw .sqlite binary for the Safe Mode rescue (spec §3). */
  readonly exportBinary: Uint8Array;
  readonly query: readonly SqlRow[];
  readonly execute: SqlExecuteResult;
  readonly transaction: null;
  /** Integrity check of candidate restore bytes, run before they overwrite anything (#198). */
  readonly verifyBinary: VerifyBinaryResult;
  /** The stored database's raw bytes, or `null` where this origin has none (#255). */
  readonly readDatabaseFile: Uint8Array | null;
  readonly writeDatabaseFile: WriteDatabaseFileResult;
  readonly wipeDatabaseFiles: null;
  /** The merged snapshot plus the merge's counters, ready to push (#173). */
  readonly snapshotMerge: SnapshotMergeResult;
  readonly close: null;
}

export type DbRequestKind = DbRequest['kind'];

/** Main thread → worker. */
export interface RpcRequestEnvelope {
  readonly id: string;
  readonly request: DbRequest;
}

/** Worker → main thread. */
export type RpcResponseEnvelope =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly ok: false; readonly error: SerializedDbError };

/**
 * Type guard for inbound response envelopes on the main thread.
 *
 * Checks the payload of whichever arm `ok` selects, not just `ok`'s type: the driver hands
 * `error` straight to `DbError.fromSerialized`, so an `ok: false` envelope without a well-formed
 * error would fail *inside* the rejection path rather than surfacing as a database error.
 */
export function isRpcResponseEnvelope(value: unknown): value is RpcResponseEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; ok?: unknown; error?: unknown };
  if (typeof candidate.id !== 'string') return false;
  // `result` is `unknown`, so its presence is all there is to prove — and `undefined` is a
  // legitimate result, which is why this is `in` rather than a value check.
  if (candidate.ok === true) return 'result' in candidate;
  if (candidate.ok === false) return isSerializedDbError(candidate.error);
  return false;
}
