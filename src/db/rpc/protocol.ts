/**
 * The strongly typed RPC protocol spoken across the worker bridge (spec §2.2.3).
 *
 * Every call from the main thread is wrapped in an envelope carrying a correlation
 * `id`; the worker replies with the matching `id` and either a result or a
 * serialised error. This is a hand-rolled, promise-based postMessage wrapper —
 * chosen over Comlink to keep the bundle lean (§2.4.3) and the test-time mock
 * trivial (§8.5.3). Messages are structured-clone-safe (no functions/classes).
 */
import type { SqlParams, SqlStatement, SqlRow, SqlExecuteResult } from './driver';
import type { SerializedDbError } from '../errors';

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

/** The request union — every supported worker operation. */
export type DbRequest =
  | { readonly kind: 'init' }
  | { readonly kind: 'diagnostics' }
  | { readonly kind: 'exportBinary' }
  | { readonly kind: 'query'; readonly sql: string; readonly params?: SqlParams }
  | { readonly kind: 'execute'; readonly sql: string; readonly params?: SqlParams }
  | { readonly kind: 'transaction'; readonly statements: readonly SqlStatement[] }
  | { readonly kind: 'close' };

/** Maps each request kind to its successful result type (documentation + driver casts). */
export interface DbResultMap {
  readonly init: DbDiagnostics;
  readonly diagnostics: DbDiagnostics;
  /** Raw .sqlite binary for the Safe Mode rescue (spec §3). */
  readonly exportBinary: Uint8Array;
  readonly query: readonly SqlRow[];
  readonly execute: SqlExecuteResult;
  readonly transaction: null;
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

/** Type guard for inbound response envelopes on the main thread. */
export function isRpcResponseEnvelope(value: unknown): value is RpcResponseEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}
