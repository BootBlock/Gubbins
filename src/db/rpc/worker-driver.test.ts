/**
 * Covers the two absent failure modes from issue #299: an unanswered request must time out
 * rather than park forever, and a worker crash must make the driver permanently unusable
 * rather than leave it silently accepting calls into a dead worker.
 *
 * `Worker` is stubbed rather than spawned — the point under test is the correlation/lifecycle
 * bookkeeping on the main thread, which is exactly what a real worker would hide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../errors';
import { setStorageOutcomeObserver } from '@/features/storage/exhaustion';
import { RPC_TIMEOUT_MS, WorkerDatabaseDriver } from './worker-driver';
import type { RpcRequestEnvelope, RpcResponseEnvelope } from './protocol';

class FakeWorker implements Pick<Worker, 'postMessage' | 'terminate'> {
  readonly posted: RpcRequestEnvelope[] = [];
  terminated = false;
  readonly #listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  postMessage(message: unknown): void {
    this.posted.push(message as RpcRequestEnvelope);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.#listeners.get(type)?.delete(listener);
  }

  /** Count of live listeners, so teardown's detaching can be asserted. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this.#listeners.values()) total += set.size;
    return total;
  }

  emit(type: string, event: Event): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  /** Reply to the nth request the driver posted, as the real worker would. */
  reply(index: number, response: Omit<RpcResponseEnvelope, 'id'>): void {
    const envelope = this.posted[index];
    if (!envelope) throw new Error(`no request posted at index ${index}`);
    this.emit('message', {
      data: { ...response, id: envelope.id } as RpcResponseEnvelope,
    } as MessageEvent);
  }

  /** Reply to the nth request with a body the protocol does not describe (issue #354). */
  replyMalformed(index: number, body: Record<string, unknown>): void {
    const envelope = this.posted[index];
    if (!envelope) throw new Error(`no request posted at index ${index}`);
    this.emit('message', { data: { ...body, id: envelope.id } } as MessageEvent);
  }
}

let worker: FakeWorker;

beforeEach(() => {
  vi.useFakeTimers();
  worker = new FakeWorker();
  // Must be constructible (`new Worker(...)`), so a class rather than an arrow.
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        return worker;
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The driver reads the global `Worker` at construction, so building it per-test picks up that
 * test's stub. Note the module is imported *statically*: a dynamic import under `resetModules`
 * would hand the driver its own copy of `../errors`, and `toBeInstanceOf(DbError)` would then
 * compare against a different class.
 */
function createDriver(): WorkerDatabaseDriver {
  return new WorkerDatabaseDriver();
}

describe('WorkerDatabaseDriver', () => {
  it('resolves a call from the reply carrying its correlation id', async () => {
    const driver = createDriver();
    const rows = driver.query<{ n: number }>('SELECT 1 AS n');
    worker.reply(0, { ok: true, result: [{ n: 1 }] });
    await expect(rows).resolves.toEqual([{ n: 1 }]);
  });

  it('forwards a snapshot merge to the worker and resolves with its result (#173)', async () => {
    const driver = createDriver();
    const request = {
      mode: 'delta',
      remote: { tables: {} },
      offset: 0,
      effectiveNow: 1,
      lastSyncTimestamp: 0,
      historyPrunedBefore: 0,
      forceTies: false,
    } as unknown as Parameters<WorkerDatabaseDriver['snapshotMerge']>[0];

    const merged = driver.snapshotMerge(request);
    // The merge crosses as one coarse call — this is what keeps the local snapshot and the
    // reconcile pass off the main thread entirely.
    expect(worker.posted[0]!.request).toEqual({ kind: 'snapshotMerge', request });

    worker.reply(0, { ok: true, result: { pulled: 3 } });
    await expect(merged).resolves.toMatchObject({ pulled: 3 });
  });

  describe('failure replies', () => {
    it('rejects with the database error the worker serialised', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      worker.reply(0, {
        ok: false,
        error: new DbError('SQLITE_BUSY', 'database is locked', { resultCode: 5 }).toSerialized(),
      });
      await expect(rows).rejects.toMatchObject({ code: 'SQLITE_BUSY', resultCode: 5 });
    });

    it('rejects a call whose failure reply carries no usable error (#354)', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      // Rebuilding a DbError from this used to throw *inside* the rejection path, leaving the
      // caller parked until its budget expired rather than surfacing anything.
      worker.replyMalformed(0, { ok: false });

      await expect(rows).rejects.toBeInstanceOf(DbError);
      expect(vi.getTimerCount()).toBe(0);
      expect(driver.isUnavailable).toBe(false);
    });

    it('rejects a call whose success reply carries no result (#354)', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      worker.replyMalformed(0, { ok: true });
      await expect(rows).rejects.toBeInstanceOf(DbError);
    });

    it('ignores a malformed message that names no call, leaving in-flight work alone', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      const assertion = expect(rows).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });

      expect(() => worker.emit('message', { data: { ok: false } } as MessageEvent)).not.toThrow();
      expect(() => worker.emit('message', { data: 'not an envelope' } as MessageEvent)).not.toThrow();

      // The real call is untouched by the noise, and still settles on its own budget.
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query);
      await assertion;
    });
  });

  describe('request timeouts', () => {
    it('rejects an unanswered request with WORKER_TIMEOUT once its budget elapses', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      const assertion = expect(rows).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });

      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query);
      await assertion;
    });

    it('does not time out a call that was answered in time', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      worker.reply(0, { ok: true, result: [] });
      await expect(rows).resolves.toEqual([]);

      // No stray timer may survive to fire against an already-settled promise.
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query * 2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('gives long-running kinds a larger budget than an ordinary query', async () => {
      createDriver();
      expect(RPC_TIMEOUT_MS.init).toBeGreaterThan(RPC_TIMEOUT_MS.query);
      expect(RPC_TIMEOUT_MS.transaction).toBeGreaterThan(RPC_TIMEOUT_MS.query);
      expect(RPC_TIMEOUT_MS.exportBinary).toBeGreaterThan(RPC_TIMEOUT_MS.query);
    });

    it('ignores a reply that arrives after its request timed out', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      const assertion = expect(rows).rejects.toBeInstanceOf(DbError);
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query);
      await assertion;

      // The late reply must not throw, and must leave the driver usable.
      expect(() => worker.reply(0, { ok: true, result: [] })).not.toThrow();
      expect(driver.isUnavailable).toBe(false);
    });

    it('gives close() the shortest budget, so the recovery path never waits on a wedged worker', () => {
      expect(RPC_TIMEOUT_MS.close).toBeLessThan(RPC_TIMEOUT_MS.query);
    });

    it('evicts a call whose payload could not be posted, leaving no armed timer', async () => {
      const driver = createDriver();
      vi.spyOn(worker, 'postMessage').mockImplementation(() => {
        throw new DOMException('could not be cloned', 'DataCloneError');
      });

      // Nothing will ever answer a request that never left the main thread, so it must reject
      // now rather than sit in `#pending` until its budget expires.
      await expect(driver.query('SELECT 1')).rejects.toBeInstanceOf(DbError);
      expect(vi.getTimerCount()).toBe(0);
      expect(driver.isUnavailable).toBe(false);
    });

    it('evicts timed-out calls so the pending map cannot grow without bound', async () => {
      const driver = createDriver();
      const calls = Array.from({ length: 5 }, () => driver.query('SELECT 1'));
      const assertions = calls.map((call) => expect(call).rejects.toBeInstanceOf(DbError));

      // A wedged worker gives up one queued call per budget, not all five at once: each is only
      // late once it is the one the worker should be running (#554). Bounded either way, which
      // is what this test is for — nothing is left parked in `#pending`.
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query * calls.length);
      await Promise.all(assertions);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  /**
   * Issue #554. The worker runs one request at a time, so a request behind a long one has not
   * started — and spending its budget while it queued rejected calls the worker went on to run
   * and commit, telling the caller a write had failed that the database had kept.
   */
  describe('queued requests (issue #554)', () => {
    it('does not spend a queued request’s budget while the worker is busy with another', async () => {
      const driver = createDriver();
      const bulk = driver.transaction([{ sql: 'INSERT INTO items VALUES (1)' }]);
      const settled = vi.fn();
      const write = driver.execute('UPDATE items SET name = ?', ['x']).then(settled, settled);

      // Five times the `execute` budget passes with the import still running (and still inside
      // its own). The write is queued behind it, not late: the old post-time budget rejected it
      // here while it was perfectly alive, and the worker went on to commit it.
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.execute * 5);
      expect(settled).not.toHaveBeenCalled();

      // Both still resolve normally once the worker drains the queue.
      worker.reply(0, { ok: true, result: null });
      worker.reply(1, { ok: true, result: { rowsModified: 1, lastInsertRowId: null } });
      await expect(bulk).resolves.toBeUndefined();
      await write;
      expect(settled).toHaveBeenCalledWith({ rowsModified: 1, lastInsertRowId: null });
    });

    it('starts a queued request’s budget only once the one ahead of it is answered', async () => {
      const driver = createDriver();
      const bulk = driver.transaction([{ sql: 'INSERT INTO items VALUES (1)' }]);
      const write = driver.execute('UPDATE items SET name = ?', ['x']);
      const settled = vi.fn();
      const watched = write.then(settled, settled);
      const assertions = [
        expect(bulk).resolves.toBeUndefined(),
        expect(write).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' }),
      ];

      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.transaction - 1);
      // Still unsettled just shy of the *import's* budget: post-time arming would have given up on
      // it 269 seconds ago. Asserted before the reply, or the rejection below could be that one.
      expect(settled).not.toHaveBeenCalled();
      worker.reply(0, { ok: true, result: null });

      // Now it is the request the worker is on, and gets its own full budget from that moment —
      // not whatever was left of one started when it was posted.
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.execute - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(assertions);
      await watched;
    });

    it('still bounds a wedged worker: each pending call gives up in turn', async () => {
      const driver = createDriver();
      const first = driver.query('SELECT 1');
      const second = driver.query('SELECT 2');
      const firstAssertion = expect(first).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
      const secondAssertion = expect(second).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
      const secondSettled = vi.fn();
      const watched = second.then(secondSettled, secondSettled);

      // The worker answers nothing at all. The first is genuinely overdue…
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query);
      await firstAssertion;
      expect(secondSettled).not.toHaveBeenCalled();

      // …and the second, now the one the worker should be on, follows a budget later (#299).
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query);
      await secondAssertion;
      await watched;
      expect(vi.getTimerCount()).toBe(0);
      expect(driver.isUnavailable).toBe(false);
    });

    it('gives close() its budget from the moment it is posted, so recovery never queues', async () => {
      const driver = createDriver();
      const bulk = driver.transaction([{ sql: 'INSERT INTO items VALUES (1)' }]);
      const bulkAssertion = expect(bulk).rejects.toBeInstanceOf(DbError);

      // `close` is awaited by the Safe Mode reset and ends in `terminate()` regardless, so its
      // budget is the caller's patience — waiting out a 300s import would freeze the very screen
      // the user reached for because the database is stuck.
      const closed = driver.close();
      const closedAssertion = expect(closed).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.close);
      await closedAssertion;
      expect(worker.terminated).toBe(true);

      await bulkAssertion;
    });
  });

  describe('worker failure', () => {
    it('rejects everything in flight with WORKER_UNAVAILABLE', async () => {
      const driver = createDriver();
      const first = driver.query('SELECT 1');
      const second = driver.execute('DELETE FROM items');
      const assertions = [
        expect(first).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' }),
        expect(second).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' }),
      ];

      worker.emit('error', new ErrorEvent('error', { message: 'wasm trap' }));
      await Promise.all(assertions);
    });

    it('marks the driver dead so later calls reject immediately instead of hanging', async () => {
      const driver = createDriver();
      worker.emit('error', new ErrorEvent('error', { message: 'wasm trap' }));
      expect(driver.isUnavailable).toBe(true);

      const posted = worker.posted.length;
      await expect(driver.query('SELECT 1')).rejects.toMatchObject({
        code: 'WORKER_UNAVAILABLE',
      });
      // The whole point: nothing is posted into a worker that can never answer.
      expect(worker.posted.length).toBe(posted);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('tears the worker down and detaches its listeners', async () => {
      const driver = createDriver();
      worker.emit('error', new ErrorEvent('error', { message: 'boom' }));
      expect(worker.terminated).toBe(true);
      expect(worker.listenerCount).toBe(0);
      expect(driver.isUnavailable).toBe(true);
    });

    it('treats a messageerror as fatal too', async () => {
      const driver = createDriver();
      worker.emit('messageerror', new Event('messageerror'));
      await expect(driver.diagnostics()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    });

    it('keeps the crash reason rather than reporting a later call as a plain dispose', async () => {
      const driver = createDriver();
      worker.emit('error', new ErrorEvent('error', { message: 'wasm trap' }));
      await expect(driver.query('SELECT 1')).rejects.toThrowError(/wasm trap/);
    });
  });

  /**
   * Issue #504: the storage tier used to come from `navigator.storage.estimate()` alone, so a
   * write that genuinely ran out of space changed nothing. This is the one point every database
   * outcome passes through, which is why the report lives here rather than at each call site.
   */
  describe('storage-exhaustion reporting', () => {
    const onExhausted = vi.fn();
    const onWriteSucceeded = vi.fn();

    beforeEach(() => {
      onExhausted.mockClear();
      onWriteSucceeded.mockClear();
      setStorageOutcomeObserver({ onExhausted, onWriteSucceeded });
    });
    afterEach(() => setStorageOutcomeObserver(null));

    it('reports a SQLITE_FULL failure so the tier can stop believing the estimate', async () => {
      const driver = createDriver();
      const write = driver.execute('INSERT INTO items DEFAULT VALUES');
      worker.reply(0, {
        ok: false,
        error: new DbError('SQLITE_FULL', 'database or disk is full', { resultCode: 13 }).toSerialized(),
      });
      await expect(write).rejects.toMatchObject({ code: 'SQLITE_FULL' });
      expect(onExhausted).toHaveBeenCalledTimes(1);
    });

    it('leaves failures that are nothing to do with space alone', async () => {
      const driver = createDriver();
      const write = driver.execute('INSERT INTO items DEFAULT VALUES');
      worker.reply(0, { ok: false, error: new DbError('SQLITE_BUSY', 'database is locked').toSerialized() });
      await expect(write).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
      expect(onExhausted).not.toHaveBeenCalled();
    });

    it('reports a write that lands — the only evidence that can clear an observed failure', async () => {
      const driver = createDriver();
      const write = driver.transaction([{ sql: 'INSERT INTO items DEFAULT VALUES' }]);
      worker.reply(0, { ok: true, result: null });
      await expect(write).resolves.toBeUndefined();
      expect(onWriteSucceeded).toHaveBeenCalledTimes(1);
    });

    it('does not treat a successful read as evidence that storage accepts writes', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      worker.reply(0, { ok: true, result: [] });
      await expect(rows).resolves.toEqual([]);
      expect(onWriteSucceeded).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('rejects in-flight calls and refuses new ones', async () => {
      const driver = createDriver();
      const rows = driver.query('SELECT 1');
      const assertion = expect(rows).rejects.toBeInstanceOf(DbError);

      driver.dispose();
      await assertion;
      expect(worker.terminated).toBe(true);
      await expect(driver.query('SELECT 1')).rejects.toBeInstanceOf(DbError);
    });

    it('is idempotent, and close() on a dead driver is a no-op', async () => {
      const driver = createDriver();
      worker.emit('error', new ErrorEvent('error', { message: 'boom' }));
      const posted = worker.posted.length;

      driver.dispose();
      await expect(driver.close()).resolves.toBeUndefined();
      expect(worker.posted.length).toBe(posted);
    });
  });
});
