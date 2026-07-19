/**
 * Production database driver — the main-thread client of the database Web Worker
 * (spec §2.2.3). Implements IDatabaseDriver by marshalling each call across the
 * postMessage bridge with a correlation id and awaiting the matching reply.
 *
 * The React main thread never imports the SQLite WASM binary; it only ever holds
 * one of these (§2.2.2). Constructed lazily as an app-wide singleton in ../client.
 *
 * **Every call is bounded, and a dead worker stays dead (issue #299).** A postMessage
 * bridge gives no delivery guarantee: a wedged OPFS sync handle, a WASM trap that never
 * surfaces as an `error` event, or a browser-killed worker all present identically as
 * silence. Left unbounded, each such call parks a promise forever and the UI waiting on
 * it simply spins — no rejection, no error boundary, nothing to tell the user that a
 * reload is the only way out. So:
 *
 *  - every request carries a {@link RPC_TIMEOUT_MS} budget, after which it rejects with
 *    `WORKER_TIMEOUT` and is evicted from `#pending` (which also bounds that map); and
 *  - a worker failure latches a terminal `WORKER_UNAVAILABLE` error, so later calls
 *    reject *immediately* instead of posting into a worker that can never answer.
 *
 * A timeout deliberately does **not** latch: one slow statement is not proof the worker
 * is gone, and a late reply is harmless (its correlation id no longer matches anything).
 */
import { DbError } from '../errors';
import {
  isRpcResponseEnvelope,
  type DbDiagnostics,
  type DbRequest,
  type RpcRequestEnvelope,
} from './protocol';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlStatement } from './driver';

/**
 * Per-request budgets, in milliseconds. Generous by design — these exist to convert an
 * infinite hang into an error, not to police slow queries, so a false positive on a
 * legitimately long operation is the failure mode worth avoiding. `init` (which runs
 * migrations), `exportBinary` (which serialises the whole database) and `transaction`
 * (which carries bulk imports) get the long budget for exactly that reason.
 *
 * @internal Exported for unit tests only.
 */
export const RPC_TIMEOUT_MS: Readonly<Record<DbRequest['kind'], number>> = {
  init: 300_000,
  exportBinary: 300_000,
  transaction: 300_000,
  query: 30_000,
  execute: 30_000,
  diagnostics: 30_000,
  // Deliberately the shortest: `close` is awaited by the Safe Mode reset, and a wedged worker is
  // exactly the state a user reaches for that reset in. Waiting 30s to give up on a teardown that
  // ends in `terminate()` anyway just freezes the recovery path.
  close: 5_000,
};

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class WorkerDatabaseDriver implements IDatabaseDriver {
  readonly #worker: Worker;
  readonly #pending = new Map<string, PendingCall>();
  /**
   * Set once the driver can never serve another call — disposed, closed, or the worker
   * died. Non-null is the single "unusable" predicate, and holding the *error* rather
   * than a boolean is what lets `#send` reject with the real reason (a crash reads very
   * differently from a deliberate dispose).
   */
  #fatal: DbError | null = null;

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

  /** True once the driver is permanently unusable; only a reload restores the database. */
  get isUnavailable(): boolean {
    return this.#fatal !== null;
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
    if (this.#fatal) return;
    try {
      await this.#send<null>({ kind: 'close' });
    } finally {
      this.dispose();
    }
  }

  /** Forcibly tear down the worker and reject any in-flight calls. */
  dispose(): void {
    if (this.#fatal) return;
    this.#teardown(new DbError('UNKNOWN', 'The database driver was disposed.'));
  }

  #send<T>(request: DbRequest): Promise<T> {
    const fatal = this.#fatal;
    if (fatal) {
      // Rebuild via the wire form rather than handing out the latched instance: every rejection
      // gets its own stack, nothing downstream can mutate a shared error, and no field is lost.
      return Promise.reject(DbError.fromSerialized(fatal.toSerialized()));
    }
    const id = crypto.randomUUID();
    // Bind the budget and kind to locals so the timer's closure holds neither the request nor
    // its payload — a bulk `transaction` would otherwise stay reachable for the whole budget.
    const kind = request.kind;
    const budget = RPC_TIMEOUT_MS[kind];
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new DbError(
            'WORKER_TIMEOUT',
            `The database did not answer a "${kind}" request within ${budget}ms.`,
          ),
        );
      }, budget);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const envelope: RpcRequestEnvelope = { id, request };
      try {
        this.#worker.postMessage(envelope);
      } catch (error) {
        // A payload that cannot be structured-cloned never reaches the worker, so nothing will
        // ever answer this id. Evict it now rather than leaving an armed timer on a dead entry —
        // that is the same unbounded-`#pending` growth this class exists to prevent.
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(DbError.fromUnknown(error));
      }
    });
  }

  #handleMessage = (event: MessageEvent): void => {
    if (!isRpcResponseEnvelope(event.data)) return;
    const response = event.data;
    const pending = this.#pending.get(response.id);
    // Either a reply to something we never sent, or one that arrived after its own timeout
    // fired — both are already settled, so dropping it is correct.
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(DbError.fromSerialized(response.error));
    }
  };

  #handleWorkerFailure = (event: Event): void => {
    if (this.#fatal) return;
    const detail = event instanceof ErrorEvent && event.message ? event.message : 'unknown worker failure';
    // Latch, don't merely reject: without this the driver stays nominally usable and every
    // later call posts into a worker that is gone, hanging the app with nothing surfaced.
    this.#teardown(new DbError('WORKER_UNAVAILABLE', `Database worker error: ${detail}`));
  };

  /** Make the driver permanently unusable: detach, terminate, and fail everything in flight. */
  #teardown(error: DbError): void {
    this.#fatal = error;
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.removeEventListener('error', this.#handleWorkerFailure);
    this.#worker.removeEventListener('messageerror', this.#handleWorkerFailure);
    this.#worker.terminate();
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
}
