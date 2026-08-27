/**
 * Caller-supplied **idempotency keys** for the bridge's mutating endpoints (issue #567).
 *
 * A bridge write is a read-modify-write of the whole snapshot, so on a large inventory it can
 * take longer than a client's request timeout — the Home Assistant integration's, for one. The
 * bridge does not abandon a write when the caller goes away (the snapshot publish is the last
 * step, and stopping midway is its own hazard), so a timed-out call has usually *succeeded* by
 * the time the caller gives up. Every write the bridge accepts is a **relative** change — a
 * signed delta, a transfer of an amount, a loan opened — so re-sending one moves the number
 * again rather than converging. A retry after a timeout therefore double-applies.
 *
 * A key closes that: the caller names its attempt, and a repeat of the same attempt is answered
 * with the first one's result instead of being applied a second time. The three cases a caller
 * can actually be in are all covered:
 *
 *   1. **The first call is still running** — the repeat joins it and gets the same answer, rather
 *      than queueing behind it on the snapshot mutex and applying a second time afterwards.
 *   2. **The first call finished** — the stored result is replayed.
 *   3. **The first call failed** — the entry is dropped, so the repeat genuinely re-runs. A
 *      failed write never reached the atomic publish, so nothing was applied and re-running is
 *      the correct, and only useful, answer.
 *
 * Reusing one key for a *different* change is a caller mistake, not a retry, and is refused
 * rather than silently answered with the earlier result ({@link IdempotencyConflictError}).
 *
 * The store is deliberately in-memory and bounded (a fixed entry cap plus a TTL): it exists to
 * absorb a retry that follows a timeout by seconds or minutes, not to be a durable log. A bridge
 * restart forgets every key, which is the honest behaviour — it also forgot whatever was in
 * flight.
 */

/** How many keys are remembered before the oldest settled entry is dropped. */
export const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 128;

/**
 * How long a key is remembered. Fifteen minutes comfortably covers "the automation errored and
 * I ran it again", which is the retry this exists for, without holding results for a caller that
 * has long since moved on.
 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60_000;

/** The longest key accepted. Generous for a UUID or a composite id, short of anything abusive. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * The characters a key may use. Deliberately narrow: a UUID, a ULID, a timestamped composite or
 * a base64url token all pass, while a comma does not — so two conflicting `Idempotency-Key`
 * headers, which Node joins into `a,b`, are refused rather than quietly treated as one odd key.
 */
const KEY_PATTERN = /^[A-Za-z0-9._:+=/-]+$/;

/** True when `value` is a well-formed idempotency key (see {@link MAX_IDEMPOTENCY_KEY_LENGTH}). */
export function isValidIdempotencyKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH && KEY_PATTERN.test(value);
}

/**
 * A key that has already been used for a materially different request. The transport maps this to
 * a `422` — the body is well-formed, and it is the *combination* of key and content that is
 * refused.
 *
 * (Explicit field assignment rather than a constructor parameter property: the bridge runs under
 * Node's strip-only TypeScript mode, which rejects those.)
 */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
  constructor(message: string) {
    super(message);
  }
}

/** What one guarded call produced, and whether it was replayed rather than run. */
export interface IdempotentOutcome<T> {
  readonly value: T;
  readonly replayed: boolean;
}

/** Identifies one attempt: who is asking, what they called it, and what they asked for. */
export interface IdempotentRequest {
  /**
   * The namespace the key belongs to — the authorised user. Two callers that happen to pick the
   * same key are asking two unrelated questions, so they must not collide (nor be told they
   * conflict).
   */
  readonly scope: string;
  /** The caller's key, or undefined when it supplied none (then nothing is remembered). */
  readonly key: string | undefined;
  /** A stable rendering of the request, compared to spot a key reused for a different change. */
  readonly fingerprint: string;
}

export interface IdempotencyStore {
  /**
   * Run `fn` under `request`'s key, replaying a previous result for a repeat of the same request.
   * With no key it is a plain pass-through, so an un-keyed caller is unaffected.
   */
  run<T>(request: IdempotentRequest, fn: () => Promise<T>): Promise<IdempotentOutcome<T>>;
}

export interface IdempotencyStoreOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  /** Injectable clock so the TTL is testable without waiting for it. */
  readonly now?: () => number;
}

interface Entry {
  readonly fingerprint: string;
  readonly value: Promise<unknown>;
  readonly createdAt: number;
  /** In-flight entries are never evicted — dropping one would let a duplicate apply twice. */
  settled: boolean;
}

/** Build an in-memory {@link IdempotencyStore}. One per write executor; see `write.ts`. */
export function createIdempotencyStore(options: IdempotencyStoreOptions = {}): IdempotencyStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const now = options.now ?? (() => Date.now());
  // Insertion-ordered, which is what makes the size cap an oldest-first eviction for free.
  const entries = new Map<string, Entry>();

  function prune(): void {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.settled && entry.createdAt <= cutoff) entries.delete(id);
    }
    if (entries.size < maxEntries) return;
    for (const [id, entry] of entries) {
      if (entries.size < maxEntries) break;
      if (entry.settled) entries.delete(id);
    }
  }

  return {
    async run<T>(request: IdempotentRequest, fn: () => Promise<T>): Promise<IdempotentOutcome<T>> {
      if (request.key === undefined) return { value: await fn(), replayed: false };

      // A NUL separator cannot occur in either half — a key is checked against KEY_PATTERN,
      // and a user id is a generated identifier — so the join is unambiguous without escaping.
      const id = `${request.scope}\u0000${request.key}`;
      prune();

      const existing = entries.get(id);
      if (existing !== undefined) {
        if (existing.fingerprint !== request.fingerprint) {
          throw new IdempotencyConflictError(
            'That idempotency key was already used for a different change. Use a new key, or ' +
              'repeat the original request exactly.',
          );
        }
        return { value: (await existing.value) as T, replayed: true };
      }

      const value = fn();
      const entry: Entry = { fingerprint: request.fingerprint, value, createdAt: now(), settled: false };
      entries.set(id, entry);
      // A failure applied nothing (the snapshot publish is the write's last act), so the key is
      // forgotten and a repeat re-runs rather than replaying the failure. Guarded on identity so
      // a late rejection cannot evict a *newer* entry that has since taken the same key.
      value.then(
        () => {
          entry.settled = true;
        },
        () => {
          entry.settled = true;
          if (entries.get(id) === entry) entries.delete(id);
        },
      );
      return { value: await value, replayed: false };
    },
  };
}

/**
 * Render a value as JSON with object keys in a stable order, so two structurally identical write
 * bodies fingerprint identically regardless of the order their fields arrived in. Plain
 * `JSON.stringify` would make `{delta, note}` and `{note, delta}` look like different requests,
 * turning an honest retry into a spurious conflict.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    // An absent field and one explicitly set to `undefined` are the same request, and
    // `JSON.stringify` drops both — so this must too, or they would fingerprint differently.
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(',')}}`;
}
