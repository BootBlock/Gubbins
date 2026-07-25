/// <reference lib="webworker" />
/**
 * The database Web Worker (spec §2.2.2, §2.2.3, §2.2.4).
 *
 * All SQLite execution lives here, isolated from the main thread. The main thread
 * communicates exclusively through the typed RPC envelopes in ../rpc/protocol.
 *
 * Concurrency model: every inbound request is appended to a single FIFO promise
 * chain, so writes are strictly serialised and rapid successive actions (e.g.
 * Continuous-mode scanning) cannot interleave or race the asynchronous boot —
 * preventing SQLITE_BUSY/SQLITE_LOCKED storms (§2.2.4). Because the OPFS VFS runs
 * synchronously within this worker, each handler completes atomically before the
 * next begins.
 */
import { createLocalDriver } from './local-driver';
import { bootstrapDatabase, readDiagnostics, type BootstrapResult } from './sqlite-bootstrap';
import { readDatabaseFile, wipeDatabaseFiles, writeDatabaseFile } from './db-file-store';
import { verifySqliteBinary } from './verify-binary';
import { DbError } from '../errors';
import { runSnapshotMerge, type SnapshotMergeRequest, type SnapshotMergeResult } from '@/features/sync/merge';
import type { BindingSpec } from '@sqlite.org/sqlite-wasm';
import type { RpcRequestEnvelope, RpcResponseEnvelope, DbRequest } from '../rpc/protocol';
import type { SqlParams, SqlRow, SqlExecuteResult, SqlStatement } from '../rpc/driver';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

let boot: BootstrapResult | null = null;
let bootPromise: Promise<BootstrapResult> | null = null;

/** Strictly ordered processing chain (spec §2.2.4). */
let queue: Promise<void> = Promise.resolve();

scope.addEventListener('message', (event: MessageEvent<RpcRequestEnvelope>) => {
  const envelope = event.data;
  queue = queue.then(() => handle(envelope));
});

async function handle(envelope: RpcRequestEnvelope): Promise<void> {
  const { id, request } = envelope;
  try {
    const result = await dispatch(request);
    post({ id, ok: true, result });
  } catch (err) {
    const dbError = DbError.fromUnknown(err, 'UNKNOWN', sqlOf(request));
    post({ id, ok: false, error: dbError.toSerialized() });
  }
}

async function dispatch(request: DbRequest): Promise<unknown> {
  if (request.kind === 'close') {
    closeConnection();
    return null;
  }

  // Deliberately ahead of `ensureBoot`: verifying candidate restore bytes must work when the
  // live database cannot be opened at all, which is the very state Safe Mode restores from
  // (issue #198). It opens only its own transient in-memory copy.
  if (request.kind === 'verifyBinary') {
    return verifySqliteBinary(request.bytes);
  }

  // Ahead of `ensureBoot` for the same reason (issue #255): these operate on the database
  // *file*, and a file that cannot be opened is exactly what they exist to replace or clear.
  // Both mutating ones close the live connection first — the fallback VFS gives undefined
  // results for an import or a wipe over a file it still holds open.
  if (request.kind === 'readDatabaseFile') {
    return readDatabaseFile();
  }
  if (request.kind === 'writeDatabaseFile') {
    closeConnection();
    return writeDatabaseFile(request.bytes);
  }
  if (request.kind === 'wipeDatabaseFiles') {
    closeConnection();
    await wipeDatabaseFiles();
    return null;
  }

  const active = await ensureBoot();

  switch (request.kind) {
    case 'init':
    case 'diagnostics':
      return readDiagnostics(active);
    case 'query':
      return runQuery(active, request.sql, request.params);
    case 'execute':
      return runExecute(active, request.sql, request.params);
    case 'transaction':
      return runTransaction(active, request.statements);
    case 'exportBinary':
      return exportBinary(active);
    case 'snapshotMerge':
      return runMerge(active, request.request);
    default:
      return assertNever(request);
  }
}

/**
 * Release the live connection, if there is one, and forget the boot so the next request opens
 * a fresh one. Idempotent — every caller here reaches for it precisely because it cannot know
 * whether the database ever opened.
 */
function closeConnection(): void {
  const open = boot;
  // Cleared unconditionally, not just when a connection existed: a *failed* boot latches its
  // rejection in `bootPromise`, and replacing the database file is exactly the fix that should
  // let the next request try again.
  boot = null;
  bootPromise = null;
  open?.db.close();
}

function ensureBoot(): Promise<BootstrapResult> {
  if (boot) return Promise.resolve(boot);
  if (!bootPromise) {
    bootPromise = bootstrapDatabase().then((result) => {
      boot = result;
      return result;
    });
  }
  return bootPromise;
}

function runQuery(active: BootstrapResult, sql: string, params?: SqlParams): SqlRow[] {
  return active.db.selectObjects(sql, bindOf(params)) as SqlRow[];
}

function runExecute(active: BootstrapResult, sql: string, params?: SqlParams): SqlExecuteResult {
  active.db.exec(sql, { bind: bindOf(params) });
  const rowsModified = active.db.changes(false, false);
  const pointer = active.db.pointer;
  const lastInsertRowId = pointer ? active.sqlite3.capi.sqlite3_last_insert_rowid(pointer) : 0n;
  return {
    rowsModified,
    lastInsertRowId: lastInsertRowId === 0n ? null : Number(lastInsertRowId),
  };
}

/** Execute a batch atomically (spec §2.3.2): BEGIN, run all, COMMIT; ROLLBACK on any error. */
function runTransaction(active: BootstrapResult, statements: readonly SqlStatement[]): null {
  const { db } = active;
  db.exec('BEGIN;');
  try {
    for (const statement of statements) {
      db.exec(statement.sql, { bind: bindOf(statement.params) });
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw err;
  }
  return null;
}

/**
 * Run a whole sync merge here rather than on the main thread (issue #173).
 *
 * The merge is written against {@link IDatabaseDriver}, so it needs no worker-specific
 * variant: it is handed a driver bound to this connection and its reads and writes resolve
 * in-process. Everything expensive — the full local snapshot, the synchronous `reconcile`
 * pass over it, the atomic apply, the re-read — therefore happens on this thread, and only
 * the merged snapshot the network push actually needs crosses back.
 *
 * It shares the same FIFO queue as every other request (§2.2.4), so nothing can interleave
 * writes with the merge's own read-reconcile-apply sequence — which also means the UI's own
 * queries wait behind a long merge. That is the better trade, and deliberately so: they used
 * to interleave only because the main thread was blocked solid for the same period, so the app
 * could not have painted their results anyway. Now it stays interactive throughout and merely
 * loads data a beat later, and the merge gets the consistent view the §7.5 integrity rules
 * assume rather than reading around concurrent writes.
 */
function runMerge(active: BootstrapResult, request: SnapshotMergeRequest): Promise<SnapshotMergeResult> {
  const driver = createLocalDriver({
    query: (sql, params) => runQuery(active, sql, params),
    execute: (sql, params) => runExecute(active, sql, params),
    transaction: (statements) => {
      runTransaction(active, statements);
    },
  });
  return runSnapshotMerge(driver, request);
}

/**
 * Serialise the live database to a raw .sqlite binary for the Safe Mode rescue
 * (spec §3) — recoverable in an external tool such as DB Browser for SQLite.
 */
function exportBinary(active: BootstrapResult): Uint8Array {
  const pointer = active.db.pointer;
  if (!pointer) {
    throw new DbError('UNKNOWN', 'Cannot export database: the connection pointer is unavailable.');
  }
  return active.sqlite3.capi.sqlite3_js_db_export(pointer);
}

function bindOf(params?: SqlParams): BindingSpec | undefined {
  return params;
}

function sqlOf(request: DbRequest): string | undefined {
  if (request.kind === 'query' || request.kind === 'execute') return request.sql;
  return undefined;
}

function post(response: RpcResponseEnvelope): void {
  scope.postMessage(response);
}

function assertNever(value: never): never {
  throw new DbError('UNKNOWN', `Unhandled database request: ${JSON.stringify(value)}`);
}
