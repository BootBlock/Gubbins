import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  zipInVaultWorker,
  VAULT_ZIP_TIMEOUT_MS,
  VAULT_ZIP_TIMEOUT_MESSAGE,
  VAULT_ZIP_FAILED_MESSAGE,
} from './zip-in-worker';

/**
 * The shared vault-zip round trip (issue #695). The worker is faked so every way the round
 * trip can end — an answer, an `error` event, a payload that cannot be posted, and silence —
 * is exercised without spawning one. The silence case is the point of the module: it used to
 * park the caller's promise for ever.
 */

/** Stand-in for the fflate vault worker: records the request and answers only when told to. */
class FakeZipWorker {
  static instances: FakeZipWorker[] = [];
  /** Armed before a call to make the next worker's `postMessage` throw (an unclonable payload). */
  static nextPostThrows: unknown = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posts: unknown[] = [];
  terminated = 0;
  readonly postThrows: unknown;

  constructor() {
    this.postThrows = FakeZipWorker.nextPostThrows;
    FakeZipWorker.nextPostThrows = null;
    FakeZipWorker.instances.push(this);
  }

  postMessage(request: unknown) {
    if (this.postThrows) throw this.postThrows;
    this.posts.push(request);
  }

  terminate() {
    this.terminated += 1;
  }

  /** Answer as the real worker does, with the zipped bytes. */
  reply(zip: Uint8Array) {
    this.onmessage?.({ data: { zip } } as MessageEvent);
  }
}

/** The worker the call under test spawned (there is exactly one per call). */
function spawned(): FakeZipWorker {
  const worker = FakeZipWorker.instances.at(-1);
  if (!worker) throw new Error('no worker was spawned');
  return worker;
}

beforeEach(() => {
  FakeZipWorker.instances = [];
  FakeZipWorker.nextPostThrows = null;
  vi.stubGlobal('Worker', FakeZipWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('zipInVaultWorker (issue #695)', () => {
  const files = { 'manifest.json': '{}' };
  const assets = { 'images/a.webp': new Uint8Array([1, 2]) };

  it('posts the entry maps and resolves with the zipped bytes, then terminates the worker', async () => {
    const zipping = zipInVaultWorker(files, assets);
    const worker = spawned();
    expect(worker.posts).toEqual([{ files, assets }]);

    worker.reply(new Uint8Array([7, 8, 9]));
    await expect(zipping).resolves.toEqual(new Uint8Array([7, 8, 9]));
    expect(worker.terminated).toBe(1);
  });

  it('rejects with an authored sentence when the worker fails, keeping the event as the cause', async () => {
    const zipping = zipInVaultWorker(files, assets);
    const worker = spawned();
    const event = { message: 'Failed to fetch dynamically imported module' };
    worker.onerror?.(event);

    // Wrapped rather than passed through: an `ErrorEvent` is not an `Error`, so `describeError`
    // would fall through to the call site's generic copy and the console would log an opaque event.
    await expect(zipping).rejects.toThrow(VAULT_ZIP_FAILED_MESSAGE);
    await expect(zipping).rejects.toHaveProperty('cause', event);
    expect(worker.terminated).toBe(1);
  });

  it('rejects immediately when the request cannot be handed over at all', async () => {
    FakeZipWorker.nextPostThrows = new DOMException('could not be cloned', 'DataCloneError');
    // No timers advanced: a request that never reached the worker must not wait out the budget.
    await expect(zipInVaultWorker(files, assets)).rejects.toThrow('could not be cloned');
    expect(spawned().terminated).toBe(1);
  });

  it('rejects a worker that goes silent rather than waiting for ever', async () => {
    vi.useFakeTimers();
    const zipping = zipInVaultWorker(files, assets);
    const worker = spawned();
    expect(worker.posts).toHaveLength(1);

    // One tick short of the budget the caller is still waiting — the bound is a bound, not a
    // shorter deadline that would fail a legitimately slow zip.
    await vi.advanceTimersByTimeAsync(VAULT_ZIP_TIMEOUT_MS - 1);
    let settled = false;
    void zipping.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(zipping).rejects.toThrow(VAULT_ZIP_TIMEOUT_MESSAGE);
    // Terminated, not merely abandoned: the worker only computes bytes, so there is no side effect
    // to land late — and reclaiming it frees whatever the half-built archive was holding.
    expect(worker.terminated).toBe(1);
  });

  it('drops an answer that arrives after the budget expired', async () => {
    vi.useFakeTimers();
    const zipping = zipInVaultWorker(files, assets);
    const worker = spawned();
    // Asserted before the clock moves: the rejection lands inside `advanceTimersByTimeAsync`, so
    // attaching the handler afterwards would leave it momentarily unhandled.
    const timedOut = expect(zipping).rejects.toThrow(VAULT_ZIP_TIMEOUT_MESSAGE);

    await vi.advanceTimersByTimeAsync(VAULT_ZIP_TIMEOUT_MS);
    await timedOut;

    // The caller has already been told it failed, so late bytes must not re-settle the promise
    // (and the detached handler means the worker cannot reach it at all).
    expect(worker.onmessage).toBeNull();
    worker.reply(new Uint8Array([1]));
    await expect(zipping).rejects.toThrow(VAULT_ZIP_TIMEOUT_MESSAGE);
    expect(worker.terminated).toBe(1);
  });
});
