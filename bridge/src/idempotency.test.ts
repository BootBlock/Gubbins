/**
 * Unit tests for the in-memory idempotency store (issue #567).
 *
 * The behaviour under test is exactly what makes a retry-after-timeout safe: a repeat of the same
 * request is answered rather than re-run, an *in-flight* repeat joins the original instead of
 * queueing behind it, a failure is forgotten so a repeat genuinely re-runs, and a key reused for a
 * different request is refused rather than silently answered with the wrong result.
 */
import { describe, expect, it } from 'vitest';
import {
  createIdempotencyStore,
  IdempotencyConflictError,
  isValidIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  stableStringify,
} from './idempotency.ts';

const ACTOR = 'user-admin';

/** A request under one key, with a fingerprint derived from `body` the way `write.ts` does. */
function request(key: string | undefined, body: unknown = { delta: 1 }) {
  return { scope: ACTOR, key, fingerprint: stableStringify(body) };
}

/** A deferred promise, so a test can hold one call in flight while it makes another. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('key validation', () => {
  it('accepts a UUID, a ULID and a base64url-ish token', () => {
    expect(isValidIdempotencyKey('2f1a9c8e-0b57-4a2d-9f3e-6c5d4b3a2109')).toBe(true);
    expect(isValidIdempotencyKey('01J8ZC5S9K7M3QW0X2Y4Z6A8B1')).toBe(true);
    expect(isValidIdempotencyKey('scale:filament-pla/2026-08-27T10:00')).toBe(true);
  });

  it('refuses an empty key, an over-long one, and a comma-joined pair', () => {
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toBe(false);
    // Node joins two `Idempotency-Key` headers into `a,b`; two keys are not one key.
    expect(isValidIdempotencyKey('key-a,key-b')).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
  });
});

describe('stableStringify', () => {
  it('fingerprints the same fields identically whatever order they arrived in', () => {
    expect(stableStringify({ delta: -1, note: 'used' })).toBe(stableStringify({ note: 'used', delta: -1 }));
  });

  it('treats an explicitly-undefined field as absent, exactly as JSON.stringify does', () => {
    expect(stableStringify({ delta: 1, note: undefined })).toBe(stableStringify({ delta: 1 }));
  });

  it('distinguishes genuinely different requests', () => {
    expect(stableStringify({ delta: 1 })).not.toBe(stableStringify({ delta: 2 }));
    expect(stableStringify({ delta: 1 })).not.toBe(stableStringify({ delta: '1' }));
  });
});

describe('the idempotency store', () => {
  it('runs every call when no key is supplied', async () => {
    const store = createIdempotencyStore();
    let runs = 0;
    const run = () => store.run(request(undefined), async () => ++runs);
    expect(await run()).toEqual({ value: 1, replayed: false });
    expect(await run()).toEqual({ value: 2, replayed: false });
  });

  it('replays a settled result instead of running the operation again', async () => {
    const store = createIdempotencyStore();
    let runs = 0;
    const first = await store.run(request('key-1'), async () => ++runs);
    const second = await store.run(request('key-1'), async () => ++runs);
    expect(first).toEqual({ value: 1, replayed: false });
    expect(second).toEqual({ value: 1, replayed: true });
    expect(runs).toBe(1);
  });

  it('joins an in-flight call rather than queueing a second one behind it', async () => {
    const store = createIdempotencyStore();
    const gate = deferred<number>();
    let runs = 0;
    const first = store.run(request('key-1'), () => {
      runs += 1;
      return gate.promise;
    });
    // The repeat arrives while the first is still working — the timed-out-caller case exactly.
    const second = store.run(request('key-1'), async () => ++runs);
    gate.resolve(7);
    expect(await first).toEqual({ value: 7, replayed: false });
    expect(await second).toEqual({ value: 7, replayed: true });
    expect(runs).toBe(1);
  });

  it('forgets a failed call so a repeat genuinely re-runs', async () => {
    const store = createIdempotencyStore();
    let runs = 0;
    await expect(
      store.run(request('key-1'), async () => {
        runs += 1;
        throw new Error('snapshot unavailable');
      }),
    ).rejects.toThrow('snapshot unavailable');
    expect(await store.run(request('key-1'), async () => ++runs)).toEqual({ value: 2, replayed: false });
  });

  it('propagates the original failure to an in-flight repeat, then still forgets it', async () => {
    const store = createIdempotencyStore();
    const gate = deferred<number>();
    let runs = 0;
    const first = store.run(request('key-1'), () => {
      runs += 1;
      return gate.promise;
    });
    const second = store.run(request('key-1'), async () => ++runs);
    gate.reject(new Error('disk full'));
    await expect(first).rejects.toThrow('disk full');
    await expect(second).rejects.toThrow('disk full');
    expect(runs).toBe(1);
    expect(await store.run(request('key-1'), async () => ++runs)).toEqual({ value: 2, replayed: false });
  });

  it('refuses a key reused for a materially different request', async () => {
    const store = createIdempotencyStore();
    await store.run(request('key-1', { delta: 1 }), async () => 'first');
    await expect(store.run(request('key-1', { delta: -5 }), async () => 'second')).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('keeps two callers apart even when they pick the same key', async () => {
    const store = createIdempotencyStore();
    const mine = { scope: 'user-a', key: 'shared', fingerprint: stableStringify({ delta: 1 }) };
    const theirs = { scope: 'user-b', key: 'shared', fingerprint: stableStringify({ delta: -9 }) };
    expect(await store.run(mine, async () => 'a')).toEqual({ value: 'a', replayed: false });
    // Same key, different owner, different body — neither a replay nor a conflict.
    expect(await store.run(theirs, async () => 'b')).toEqual({ value: 'b', replayed: false });
  });

  it('forgets a key once its time-to-live has passed', async () => {
    let clock = 1_000;
    const store = createIdempotencyStore({ ttlMs: 60_000, now: () => clock });
    let runs = 0;
    await store.run(request('key-1'), async () => ++runs);
    clock += 59_000;
    expect(await store.run(request('key-1'), async () => ++runs)).toEqual({ value: 1, replayed: true });
    clock += 2_000; // now past the TTL
    expect(await store.run(request('key-1'), async () => ++runs)).toEqual({ value: 2, replayed: false });
  });

  it('drops the oldest keys once the entry cap is reached, and keeps the newest', async () => {
    const store = createIdempotencyStore({ maxEntries: 3 });
    let runs = 0;
    for (const key of ['a', 'b', 'c', 'd']) {
      await store.run(request(key), async () => ++runs);
    }
    // 'a' was evicted to make room for 'd', so repeating it re-runs; 'd' is still remembered.
    expect(await store.run(request('a'), async () => ++runs)).toEqual({ value: 5, replayed: false });
    expect(await store.run(request('d'), async () => ++runs)).toEqual({ value: 4, replayed: true });
  });

  it('evicts in-flight entries once they pile up far past the cap, rather than growing forever', async () => {
    const store = createIdempotencyStore({ maxEntries: 2 }); // hard ceiling = 2 x 4 = 8
    const gate = deferred<string>();
    // Nine concurrent, distinct keys, none of which can settle: preferring settled entries has
    // nothing to drop, so the ceiling is the only thing standing between this and unbounded growth.
    const inFlight = Array.from({ length: 9 }, (_, i) =>
      store.run(request(`key-${i}`, { delta: i }), () => gate.promise),
    );
    // The oldest key was evicted, so repeating it runs afresh instead of joining.
    const repeatOldest = store.run(request('key-0', { delta: 0 }), async () => 'ran again');
    gate.resolve('original');
    await Promise.all(inFlight);
    expect(await repeatOldest).toEqual({ value: 'ran again', replayed: false });
  });

  it('never evicts an in-flight entry, however small the cap', async () => {
    const store = createIdempotencyStore({ maxEntries: 1 });
    const gate = deferred<string>();
    let runs = 0;
    const first = store.run(request('key-1'), () => {
      runs += 1;
      return gate.promise;
    });
    // A second, unrelated key would push the cap over — the in-flight one must survive it.
    await store.run(request('key-2', { delta: 2 }), async () => 'other');
    const repeat = store.run(request('key-1'), async () => 'ran again');
    gate.resolve('original');
    expect(await first).toEqual({ value: 'original', replayed: false });
    expect(await repeat).toEqual({ value: 'original', replayed: true });
    expect(runs).toBe(1);
  });
});
