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
 *
 * **A budget measures the worker's work, not the caller's wait (issue #554).** The worker runs
 * one request at a time off a strict FIFO chain (spec §2.2.4), so a request posted behind a bulk
 * import is not late — it has not started. Spending its budget while it queued was how an
 * ordinary `execute` (30s) came to reject behind a `transaction` (300s) *while remaining alive*:
 * nothing cancels a timed-out request, so the worker went on to run and commit it, and the caller
 * had already been told it failed. So the budget is armed for the one request the worker is
 * actually working on — the front of `#pending`, which is insertion-ordered on the same posting
 * order — and the next is armed as each reply arrives. Everything behind waits its turn, and the
 * total wait stays bounded because each request ahead is itself bounded.
 *
 * The exception is {@link POST_TIME_BUDGET_KINDS}, the two teardown calls, whose budget is the
 * caller's patience rather than an estimate of the work.
 *
 * One residual imprecision, which needs a cancellation message in the protocol to close properly:
 * a request evicted *by its own timeout* is still running in the worker, so the next request's
 * budget starts before the worker has actually reached it. That only applies once a genuine
 * breach has already happened, and callers treat `WORKER_TIMEOUT` as an unknown outcome rather
 * than a refusal (see `isUnknownWriteOutcome`) precisely because of it.
 */
import { DbError } from '../errors';
import {
  isRpcResponseEnvelope,
  type DbDiagnostics,
  type DbRequest,
  type DbRequestKind,
  type RpcRequestEnvelope,
  type VerifyBinaryResult,
  type WriteDatabaseFileResult,
} from './protocol';
import type { IDatabaseDriver, SqlExecuteResult, SqlParams, SqlRow, SqlStatement } from './driver';
import type { SnapshotMergeRequest, SnapshotMergeResult } from '@/features/sync/merge';

/**
 * Per-request budgets, in milliseconds. Generous by design — these exist to convert an
 * infinite hang into an error, not to police slow queries, so a false positive on a
 * legitimately long operation is the failure mode worth avoiding. `init` (which runs
 * migrations), `exportBinary` (which serialises the whole database) and `transaction`
 * (which carries bulk imports) get the long budget for exactly that reason.
 *
 * Each is how long the **worker** may spend on that one request, counted from the moment it
 * reaches the front of the queue rather than from the moment it was posted (issue #554) — so
 * these numbers can be read as "how long this operation could reasonably take" without also
 * having to allow for whatever else the tab might have in flight at the time.
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
  // Reads every page of the candidate file, so it scales with the database being restored —
  // budgeted like the other whole-database operations rather than like a query.
  verifyBinary: 300_000,
  // Whole-database file operations (#255), so budgeted alongside them.
  readDatabaseFile: 300_000,
  writeDatabaseFile: 300_000,
  // Budgeted like `close`, and for the same reason: it only blanks the VFS's handful of file
  // slots, and it is awaited by the Safe Mode purge — which a user reaches for precisely when
  // the worker is wedged. Waiting 30s before falling through to the file-system sweep that
  // follows it would just freeze the recovery path. See POST_TIME_BUDGET_KINDS.
  wipeDatabaseFiles: 5_000,
  // Reads, reconciles and rewrites the whole syncable database (#173), so it is budgeted like
  // the other whole-database operations rather than like a query.
  snapshotMerge: 300_000,
  // Deliberately the shortest: `close` is awaited by the Safe Mode reset, and a wedged worker is
  // exactly the state a user reaches for that reset in. Waiting 30s to give up on a teardown that
  // ends in `terminate()` anyway just freezes the recovery path. See POST_TIME_BUDGET_KINDS.
  close: 5_000,
};

/**
 * The requests whose budget runs from the moment they are **posted** rather than from the moment
 * the worker reaches them (issue #554).
 *
 * Both are teardown calls that Safe Mode awaits, and both end with the worker terminated whichever
 * way they settle. Their budget is the caller's patience, not an estimate of the work — so letting
 * them queue behind a long or wedged request is precisely what would freeze the screen a user
 * reached for *because* the database is stuck.
 *
 * What makes giving up early *safe* for these two, and only these two, is that the worker running
 * them late is harmless: closing a connection that is about to be terminated changes nothing, and
 * `wipeDatabaseFiles` is called by the purge that goes on to delete those same files by hand (it
 * catches and continues for exactly that reason). Every other kind waits its turn, because for
 * every other kind a wait is not a failure and a late execution is not harmless —
 * `writeDatabaseFile` is the one to hold in mind: abandoning it early and letting it run anyway
 * would overwrite the database *after* the screen had reported the restore as failed, which is
 * this issue's own bug at its worst.
 */
const POST_TIME_BUDGET_KINDS: ReadonlySet<DbRequestKind> = new Set<DbRequestKind>([
  'close',
  'wipeDatabaseFiles',
]);

/** The `id` of a message that failed the envelope guard, where it carries a usable one. */
function correlationIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

interface PendingCall {
  /** Kept so a call can be armed later, once the worker reaches it, without holding its payload. */
  readonly kind: DbRequestKind;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  /**
   * This call's armed budget, or `null` while it is still queued behind another. Mutable because
   * an ordinary call is armed when it reaches the front of the queue, not when it is posted
   * (issue #554) — see `#armHead`.
   */
  timer: ReturnType<typeof setTimeout> | null;
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

  /**
   * Run `PRAGMA integrity_check` over candidate restore bytes (issue #198). Never opens the
   * live database, so it answers even when the worker has never managed to boot one.
   */
  verifyBinary(bytes: Uint8Array): Promise<VerifyBinaryResult> {
    return this.#send<VerifyBinaryResult>({ kind: 'verifyBinary', bytes });
  }

  /**
   * Read the stored database's raw bytes **without opening it** (issue #255).
   *
   * The rescue paths read the OPFS file directly where they can; this is for the `opfs-sahpool`
   * fallback VFS, whose files no directory handle can resolve. Resolves to `null` when this
   * origin has no database at all.
   */
  readDatabaseFile(): Promise<Uint8Array | null> {
    return this.#send<Uint8Array | null>({ kind: 'readDatabaseFile' });
  }

  /**
   * Replace the stored database with raw SQLite bytes, wherever the next boot will read it
   * from (issue #255). Closes the live connection first; the caller must reload afterwards.
   */
  writeDatabaseFile(bytes: Uint8Array): Promise<WriteDatabaseFileResult> {
    return this.#send<WriteDatabaseFileResult>({ kind: 'writeDatabaseFile', bytes });
  }

  /** Clear the stored database and its sidecars through the VFS that owns them (issue #255). */
  async wipeDatabaseFiles(): Promise<void> {
    await this.#send<null>({ kind: 'wipeDatabaseFiles' });
  }

  /**
   * Run a whole sync merge inside the worker (issue #173) — this is the
   * `OffThreadSnapshotMerge` capability the sync engine feature-detects, so naming it
   * `snapshotMerge` is what switches sync off the main thread.
   */
  snapshotMerge(request: SnapshotMergeRequest): Promise<SnapshotMergeResult> {
    return this.#send<SnapshotMergeResult>({ kind: 'snapshotMerge', request });
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
    // Bound to a local so nothing below closes over the request or its payload — a bulk
    // `transaction` would otherwise stay reachable for as long as the call is pending.
    const kind = request.kind;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        kind,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
      };
      this.#pending.set(id, pending);
      // A recovery call cannot afford to wait for the queue, so its budget starts now; anything
      // else is armed by `#armHead` below, and only if the worker is free to run it (#554).
      if (POST_TIME_BUDGET_KINDS.has(kind)) pending.timer = this.#arm(id, kind);
      this.#armHead();
      const envelope: RpcRequestEnvelope = { id, request };
      try {
        this.#worker.postMessage(envelope);
      } catch (error) {
        // A payload that cannot be structured-cloned never reaches the worker, so nothing will
        // ever answer this id. Evict it now rather than leaving an armed timer on a dead entry —
        // that is the same unbounded-`#pending` growth this class exists to prevent.
        this.#forget(id);
        reject(DbError.fromUnknown(error));
      }
    });
  }

  /**
   * Arm `id`'s budget, returning the timer. Closes over the id and kind only — never the pending
   * entry — so a rejection always reads the map rather than a captured reference that may since
   * have been evicted and re-armed.
   */
  #arm(id: string, kind: DbRequestKind): ReturnType<typeof setTimeout> {
    const budget = RPC_TIMEOUT_MS[kind];
    return setTimeout(() => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#forget(id);
      pending.reject(
        new DbError('WORKER_TIMEOUT', `The database did not answer a "${kind}" request within ${budget}ms.`),
      );
    }, budget);
  }

  /**
   * Drop a call that will never be settled from `#pending` again — answered, timed out, or never
   * posted — clearing its timer and arming whatever the worker moves on to.
   */
  #forget(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.#armHead();
  }

  /**
   * Arm the budget of the request the worker is now working on, unless it is armed already.
   *
   * The worker takes one request at a time off a strict FIFO chain (spec §2.2.4) fed by this
   * driver's `postMessage` order, and `#pending` is insertion-ordered on that same order — so its
   * first entry *is* the request being worked on. Everything behind it is queued, and a queued
   * request is not late, so it carries no timer at all until its turn comes (issue #554).
   */
  #armHead(): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer === null) pending.timer = this.#arm(id, pending.kind);
      // The first entry and no further: this is a "peek at the head", not a sweep. (A
      // POST_TIME_BUDGET_KINDS call reaching the head is already armed, hence the null check.)
      break;
    }
  }

  #handleMessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    const response = isRpcResponseEnvelope(data) ? data : null;
    // A malformed reply is still read for its correlation id: it answered a real call, and
    // dropping it outright would park that caller until its budget expires for a reply that has
    // already arrived. Rejecting it below is both truthful and immediate.
    const id = response?.id ?? correlationIdOf(data);
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    // Either a reply to something we never sent, or one that arrived after its own timeout
    // fired — both are already settled, so dropping it is correct.
    if (!pending) return;
    // Before settling, not after: this reply is the worker announcing it has moved on, so the
    // next request's budget starts here — and it starts even if a caller's `.then` throws.
    this.#forget(id);
    if (!response) {
      pending.reject(new DbError('UNKNOWN', 'The database worker sent a response that could not be read.'));
    } else if (response.ok) {
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
      if (timer !== null) clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
}
