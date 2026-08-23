/**
 * Guards the request deadlines introduced for issue #632.
 *
 * Three things have to hold, and each fails in a different way:
 *
 * 1. {@link withTimeout} merges a deadline without disturbing the rest of the init. A helper that
 *    dropped `body` would break every push while looking like a timeout change.
 * 2. A transport turns an expiry into the failure it already knows how to render. A timeout that
 *    escaped as an unhandled rejection would leave the same dead control the deadline exists to
 *    prevent.
 * 3. No app-side request is issued without one. This is the part a type-check cannot see: a new
 *    transport module compiles perfectly well with no `signal`, and the symptom only appears
 *    against a peer that accepts the connection and never answers — which no test suite has.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { repoPath, sourceFiles } from '../test/repo-path';
import { FETCH_TIMEOUT_MS, timeoutSignal, withTimeout } from './fetch-timeout';
import { fetchScaleEntities, type FetchLike as ScaleFetchLike } from '@/features/inventory/scale-reading';
import {
  fetchWebhookDeliveries,
  type FetchLike as WebhookFetchLike,
} from '@/features/webhooks/bridge-client';
import { checkBridgeBuild, type FetchLike as BuildCheckFetchLike } from '@/features/sync/bridge-build-check';
import { lookupProductOnline } from '@/features/scraping/product-lookup-online';
import { httpTimeSource } from '@/features/sync/time-source';

const REPO_ROOT = repoPath(import.meta.dirname);
const SRC_DIR = repoPath(import.meta.dirname, 'src');

/** What a `fetch` rejects with when an `AbortSignal.timeout` expires. */
function timedOut(): DOMException {
  return new DOMException('The operation was aborted due to timeout.', 'TimeoutError');
}

describe('withTimeout', () => {
  it('attaches an abort signal and leaves the rest of the init untouched', () => {
    const init = { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' };
    const result = withTimeout(init, 'bridge');

    expect(result.signal).toBeInstanceOf(AbortSignal);
    expect(result.method).toBe('POST');
    expect(result.headers).toEqual({ authorization: 'Bearer x' });
    expect(result.body).toBe('{}');
  });

  it('does not mutate the init it was given', () => {
    const init = { method: 'GET', headers: {} };
    withTimeout(init, 'bridge');
    expect(init).not.toHaveProperty('signal');
  });

  it('aborts once the budget elapses', async () => {
    const signal = timeoutSignal(1);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(true);
  });

  describe('on a runtime with no AbortSignal.timeout', () => {
    const original = AbortSignal.timeout;
    afterEach(() => {
      AbortSignal.timeout = original;
    });

    it('degrades to no deadline rather than failing to make the request', () => {
      // An older browser is no worse off than it is today — the request still goes out. Throwing
      // here would turn a missing deadline into a feature that cannot run at all.
      // Assigned rather than deleted: `timeout` is inherited here, so a `delete` on the class
      // removes nothing and the stub silently tests the real implementation instead.
      AbortSignal.timeout = undefined as unknown as typeof AbortSignal.timeout;
      expect(timeoutSignal(1000)).toBeUndefined();
      expect(withTimeout({ method: 'GET' }, 'bridge')).toEqual({ method: 'GET' });
    });
  });
});

describe('FETCH_TIMEOUT_MS', () => {
  it('gives every request kind a positive budget', () => {
    for (const [kind, ms] of Object.entries(FETCH_TIMEOUT_MS)) {
      expect(ms, `${kind} needs a positive budget`).toBeGreaterThan(0);
    }
  });

  it('keeps a payload-carrying request more patient than a bare probe', () => {
    // The ordering *is* the design: one number generous enough for a snapshot upload would leave
    // a same-origin HEAD hanging for two minutes, and one tight enough for the HEAD would abort the
    // upload of a large database on a slow uplink.
    expect(FETCH_TIMEOUT_MS.probe).toBeLessThan(FETCH_TIMEOUT_MS.bridge);
    expect(FETCH_TIMEOUT_MS.bridge).toBeLessThan(FETCH_TIMEOUT_MS.bridgePush);
    expect(FETCH_TIMEOUT_MS.lookup).toBeLessThan(FETCH_TIMEOUT_MS.cloud);
  });
});

describe('a transport reports a timeout in the vocabulary its screen already speaks', () => {
  /**
   * Records the init a transport built, and rejects the way an expired `AbortSignal.timeout` does.
   *
   * The `signal` is captured and asserted *after* the call rather than inside this callback on
   * purpose: every transport wraps its `fetch` in a `catch`, so an assertion that threw in here
   * would be swallowed and reported as the very transport failure the test then asserts — a test
   * that passes whether or not the deadline was attached.
   */
  function timingOut<T>(): { readonly impl: (url: string, init: T) => Promise<never>; seen: () => T } {
    let captured: T | undefined;
    return {
      impl: (_url, init) => {
        captured = init;
        return Promise.reject(timedOut());
      },
      seen: () => {
        if (captured === undefined) throw new Error('the transport never issued a request');
        return captured;
      },
    };
  }

  it('the scale reads it as an unreachable bridge', async () => {
    const fetch = timingOut<Parameters<ScaleFetchLike>[1]>();
    const result = await fetchScaleEntities({
      baseUrl: 'http://127.0.0.1:8787',
      token: 't',
      fetchImpl: fetch.impl,
    });
    expect(fetch.seen().signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ ok: false, failure: 'bridge-unreachable' });
  });

  it('the webhook delivery log reads it as an unreachable bridge', async () => {
    const fetch = timingOut<Parameters<WebhookFetchLike>[1]>();
    const result = await fetchWebhookDeliveries({
      baseUrl: 'http://127.0.0.1:8787',
      token: 't',
      fetchImpl: fetch.impl,
    });
    expect(fetch.seen().signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ ok: false, failure: 'bridge-unreachable' });
  });

  it('the bridge build check offers no opinion', async () => {
    const fetch = timingOut<Parameters<BuildCheckFetchLike>[1]>();
    const result = await checkBridgeBuild('http://127.0.0.1:8787', 't', fetch.impl);
    expect(fetch.seen().signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ ok: false });
  });

  it('the product lookup reads it as an unreachable database', async () => {
    const fetch = timingOut<RequestInit | undefined>();
    const result = await lookupProductOnline(
      '5000112548167',
      fetch.impl as unknown as typeof globalThis.fetch,
    );
    expect(fetch.seen()?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('Couldn’t reach the product database'),
    });
  });

  it('the sync time source falls back to the local clock', async () => {
    const fetch = timingOut<RequestInit | undefined>();
    await expect(
      httpTimeSource({
        url: 'http://localhost/',
        fetchImpl: fetch.impl as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toBeNull();
    expect(fetch.seen()?.signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * A request issued with an **object-literal init** — the shape every app transport uses, and the
 * one a deadline has to be merged into. A `withTimeout(…)` call is not an object literal, so a
 * converted call site drops out of the match; a pass-through wrapper (`(url, init) => fetch(url,
 * init)`) forwards an init that already carries the signal, and is likewise not a literal.
 *
 * Two limits, stated so a future reader does not over-trust it: a call spread across more than
 * 200 characters before its init escapes the window, and the sweep judges only whether a literal
 * init reached `fetch` un-wrapped — never whether the *budget* chosen was the right one.
 */
const UNTIMED_FETCH = /(?<![\w$.])(?:[\w.]+\.)?(?:fetch|fetchImpl|doFetch)\(\s*[^;]{0,200}?,\s*\{/;

/**
 * Requests that genuinely must not carry a deadline. Add an entry only with a reason.
 *
 * `scale-stream` is a Server-Sent Events subscription that is *meant* to stay open for as long as
 * the user watches the scale, and it already takes the caller's own `AbortSignal` as the only way
 * to end one. A response deadline there would cut the live reading off mid-watch.
 */
const ALLOW_LIST: readonly string[] = ['src/features/inventory/scale-stream.ts'];

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

const scanned = sourceFiles(SRC_DIR)
  .filter((path) => UNTIMED_FETCH.test(readFileSync(path, 'utf8')))
  .map(repoRelative);

describe('every app-side request carries a deadline (issue #632)', () => {
  it('has no transport that issues a request without one', () => {
    const offenders = scanned.filter((path) => !ALLOW_LIST.includes(path));
    expect(
      offenders,
      'These issue a `fetch` with no `AbortSignal`. A peer that accepts the connection and then ' +
        'never answers leaves the promise pending, and the in-flight guard around the call keeps ' +
        'the control disabled with nothing on screen to explain it. Wrap the init in ' +
        '`withTimeout(init, kind)` from `@/lib/fetch-timeout`.',
    ).toEqual([]);
  });

  it('does not allow-list a file that now carries one', () => {
    const stale = ALLOW_LIST.filter((file) => !scanned.includes(file));
    expect(stale, 'Remove these from ALLOW_LIST — they no longer issue an un-timed request.').toEqual([]);
  });

  it('still matches an un-timed request (positive control)', () => {
    // A passing sweep finds nothing, which is indistinguishable from a pattern that quietly
    // stopped matching — so re-run it against the shapes issue #632 actually removed.
    expect(UNTIMED_FETCH.test(`await fetch(\`\${base}version.json\`, { cache: 'no-store' })`)).toBe(true);
    expect(
      UNTIMED_FETCH.test("const r = await connection.fetchImpl(request.url, {\n  method: 'GET',\n});"),
    ).toBe(true);
  });

  it('leaves a converted call site and a pass-through alone (negative control)', () => {
    expect(
      UNTIMED_FETCH.test(
        "await connection.fetchImpl(\n  request.url,\n  withTimeout({ method: 'GET', headers: { ...h } }, 'bridge'),\n);",
      ),
    ).toBe(false);
    expect(UNTIMED_FETCH.test('fetchImpl: (url, init) => fetch(url, init),')).toBe(false);
    expect(UNTIMED_FETCH.test('void queryClient.refetch({ queryKey })')).toBe(false);
  });

  it('scans the whole source tree (guards against a silently-narrow sweep)', () => {
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(500);
  });
});
