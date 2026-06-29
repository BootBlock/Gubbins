/**
 * Phase HA-5 rate-limiter tests — pure, deterministic (injected clock), no I/O.
 */
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.ts';

describe('createRateLimiter', () => {
  it('allows a burst up to capacity, then blocks', () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1, now: () => 0 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    const blocked = limiter.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
  });

  it('refills over time at refillPerSec', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false); // bucket empty
    t = 1_000; // one second → one token back
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('never refills beyond capacity', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 5, now: () => t });
    t = 10_000; // long idle — would over-fill an uncapped bucket
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('tracks clients independently', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true); // a different IP is unaffected
  });

  it('reports a sensible whole-second Retry-After for a slow refill', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 0.1, now: () => 0 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').retryAfterSec).toBe(10); // 1 token / 0.1 per sec
  });

  it('prunes idle full buckets once maxKeys is exceeded', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2, now: () => t });
    limiter.check('a'); // a: now empty (not full)
    t = 5_000; // a has long since refilled to full
    limiter.check('b');
    limiter.check('c'); // size hits maxKeys → prune full buckets (a and b) before inserting c
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });
});
