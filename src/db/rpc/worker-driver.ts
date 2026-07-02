/**
 * Production database driver — the main-thread client of the database Web Worker
 * (spec §2.2.3). Implements IDatabaseDriver by marshalling each call across the
 * postMessage bridge with a correlation id and awaiting the matching reply.
 *
 * The React main thread never imports the SQLite WASM binary; it only ever holds
 * one of these (§2.2.2). Constructed lazily as an app-wide singleton in ../client.
 */
import { DbError } from '../errors';
import {
  isRpcResponseEnvelope,
  type DbDiagnostics,
  type DbRequest,
  type RpcRequestEnvelope,
} from './protocol';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlStatement } from './driver';

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class WorkerDatabaseDriver implements IDatabaseDriver {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingCall>();
  #disposed = false;

  constructor() {
    // This exact `new Worker(new URL(...), { type: 'module' })` form is what Vite
    // statically detects to bundle the worker (and its SQLite WASM import).
    this.#worker = new Worker(new URL('../worker/database.worker.ts', import.meta.url), {
      type: 'module',
      name: 'gubbins-db',
    });
    this.#worker.addEventListener('message', this.#handleMessage);
    this.#worker.addEventListener('error', this.#handleWorkerFailure);
    this.#worker.addEventListener('messageerror', this.#handleWorkerFailure);
  }

  /** Open the OPFS database, verify FTS5, and return a diagnostics snapshot. */
  init(): Promise<DbDiagnostics> {
    return this.#send<DbDiagnostics>({ kind: 'init' });
  }

  diagnostics(): Promise<DbDiagnostics> {
    return this.#send<DbDiagnostics>({ kind: 'diagnostics' });
  }

  /** Raw .sqlite bytes for the Safe Mode rescue (spec §3). */
  exportBinary(): Promise<Uint8Array> {
    return this.#send<Uint8Array>({ kind: 'exportBinary' });
  }

  query<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow[]> {
    return this.#send<TRow[]>({ kind: 'query', sql, params });
  }

  async queryOne<TRow = SqlRow>(sql: string, params?: SqlParams): Promise<TRow | undefined> {
    const rows = await this.#send<TRow[]>({ kind: 'query', sql, params });
    return rows[0];
  }

  execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult> {
    return this.#send<SqlExecuteResult>({ kind: 'execute', sql, params });
  }

  async transaction(statements: readonly SqlStatement[]): Promise<void> {
    await this.#send<null>({ kind: 'transaction', statements });
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#send<null>({ kind: 'close' });
    } finally {
      this.dispose();
    }
  }

  /** Forcibly tear down the worker and reject any in-flight calls. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.removeEventListener('error', this.#handleWorkerFailure);
    this.#worker.removeEventListener('messageerror', this.#handleWorkerFailure);
    this.#worker.terminate();
    this.#rejectAll(new DbError('UNKNOWN', 'The database driver was disposed.'));
  }

  #send<T>(request: DbRequest): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new DbError('UNKNOWN', 'The database driver has been disposed.'));
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const envelope: RpcRequestEnvelope = { id, request };
      this.#worker.postMessage(envelope);
    });
  }

  #handleMessage = (event: MessageEvent): void => {
    if (!isRpcResponseEnvelope(event.data)) return;
    const response = event.data;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(DbError.fromSerialized(response.error));
    }
  };

  #handleWorkerFailure = (event: Event): void => {
    const detail = event instanceof ErrorEvent && event.message ? event.message : 'unknown worker failure';
    this.#rejectAll(new DbError('INIT_FAILED', `Database worker error: ${detail}`));
  };

  #rejectAll(error: DbError): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}
