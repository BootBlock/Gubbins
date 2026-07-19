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

      await vi.advanceTimersByTimeAsync(RPC_TIMEOUT_MS.query);
      await Promise.all(assertions);
      expect(vi.getTimerCount()).toBe(0);
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
