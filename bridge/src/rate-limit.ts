/**
 * Per-client token-bucket rate limiter (Phase HA-5 hardening).
 *
 * A small, **stdlib-only** abuse guard for the read-only HTTP server. It is a backstop,
 * not a security boundary: the bearer token is what protects the data, and binding to
 * loopback by default is what keeps the bridge off the LAN. But when an operator
 * deliberately exposes the bridge (`GUBBINS_BRIDGE_HOST=0.0.0.0`), a runaway query loop —
 * a misbehaving automation, a stuck voice device — should not be able to peg the host.
 * This caps the request rate per client IP and answers `429 Too Many Requests` (with a
 * `Retry-After`) once a client's bucket is empty.
 *
 * Pure and injectable: the only state is an in-memory `Map`, and the clock is injectable
 * (`now`) so the behaviour is deterministic in tests — no timers, no I/O, no dependency.
 *
 * Token-bucket semantics: a client may burst up to `capacity` requests, then is limited
 * to a sustained `refillPerSec` requests per second as the bucket refills.
 */

/** Default burst capacity (requests a fresh client may make back-to-back). */
export const DEFAULT_RATE_CAPACITY = 60;
/** Default sustained refill rate (requests per second once the burst is spent). */
export const DEFAULT_RATE_REFILL_PER_SEC = 1;
/**
 * Soft cap on tracked client keys. When exceeded, full (idle) buckets are pruned — they
 * are indistinguishable from a never-seen client, so dropping them changes no decision
 * while bounding memory against a spray of one-shot source IPs.
 */
export const DEFAULT_MAX_KEYS = 5_000;

export interface RateLimiterOptions {
  /** Maximum burst, in tokens. Must be ≥ 1. */
  readonly capacity?: number;
  /** Sustained refill, in tokens per second. Must be > 0. */
  readonly refillPerSec?: number;
  /** Injectable monotonic-ish clock in milliseconds (defaults to {@link Date.now}). */
  readonly now?: () => number;
  /** Soft cap on tracked keys before idle buckets are pruned. */
  readonly maxKeys?: number;
}

export interface RateLimitDecision {
  /** Whether this request may proceed. */
  readonly allowed: boolean;
  /** When blocked, whole seconds until the next token (for a `Retry-After` header). */
  readonly retryAfterSec: number;
}

export interface RateLimiter {
  /**
   * Account for one request from `key` (typically the client IP). Consumes a token when
   * one is available; otherwise reports how long to wait. Idempotent only in the sense
   * that *each call* costs a token — call it exactly once per request.
   */
  check(key: string): RateLimitDecision;
  /** Number of currently-tracked keys (for tests/diagnostics). */
  size(): number;
}

interface Bucket {
  /** Fractional tokens currently available. */
  tokens: number;
  /** Clock value (ms) at which `tokens` was last computed. */
  updatedAt: number;
}

/**
 * Create a token-bucket rate limiter. With the defaults a client may make 60 requests
 * back-to-back and then one per second — generous for a voice assistant or dashboard,
 * tight enough to stop a runaway loop.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_RATE_CAPACITY);
  const refillPerSec = Math.max(Number.EPSILON, options.refillPerSec ?? DEFAULT_RATE_REFILL_PER_SEC);
  const now = options.now ?? Date.now;
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);

  const buckets = new Map<string, Bucket>();

  function check(key: string): RateLimitDecision {
    const at = now();
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      if (buckets.size >= maxKeys) pruneFull();
      bucket = { tokens: capacity, updatedAt: at };
      buckets.set(key, bucket);
    } else {
      const elapsedSec = Math.max(0, (at - bucket.updatedAt) / 1000);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
      bucket.updatedAt = at;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    // Not enough for a whole token: report seconds until one accrues (≥ 1s).
    const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec));
    return { allowed: false, retryAfterSec };
  }

  /** Drop buckets that have fully refilled — equivalent to never having seen the key. */
  function pruneFull(): void {
    const at = now();
    for (const [key, bucket] of buckets) {
      const elapsedSec = Math.max(0, (at - bucket.updatedAt) / 1000);
      if (bucket.tokens + elapsedSec * refillPerSec >= capacity) buckets.delete(key);
    }
  }

  return {
    check,
    size: () => buckets.size,
  };
}
