import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit coverage for the service worker's `install` handler (spec §2.2.6) — previously
 * untested; sw.ts only ran end-to-end via the production-build browser smoke test.
 *
 * Locks in the fresh-install-vs-update distinction: a genuinely first-ever install for
 * this scope (`registration.active` is null — nothing has ever controlled it) must
 * self-activate via `skipWaiting()`, because the app's cross-origin-isolation bootstrap
 * (coi-bootstrap.js) depends on this worker taking control before the app can even boot
 * on a static host (GitHub Pages). A genuine *update* (an existing active worker) must
 * keep waiting for the user's explicit "Reload now" — a deploy must never activate
 * mid-session and discard unsaved, in-flight work.
 *
 * Note: this branch is defence-in-depth, not the sole fix for the GitHub Pages first-visit
 * deadlock (see App.test.tsx for that regression guard) — per the Service Worker spec, a
 * registration with no prior active worker activates automatically even without
 * `skipWaiting()`, since there are no already-controlled clients to protect. This test
 * exists to pin down the *intended* behaviour explicitly rather than lean on that implicit
 * spec detail, and to guard the update path (which must NOT self-activate) from regressing.
 *
 * sw.ts registers its listeners as a side effect of being imported, against the ambient
 * `self` — so this stubs the minimal ServiceWorkerGlobalScope surface it touches (caches,
 * registration, skipWaiting, clients) directly onto `globalThis` *before* a fresh import,
 * and captures the registered handler via a spy on `addEventListener` rather than
 * dispatching a real DOM event (which lacks the `waitUntil` an ExtendableEvent carries).
 */

type InstallHandler = (event: { waitUntil: (p: Promise<unknown>) => void }) => void;
type FetchHandler = (event: { request: Request; respondWith: (r: Promise<Response>) => void }) => void;

let installHandler: InstallHandler | undefined;
let fetchHandler: FetchHandler | undefined;
let cacheMatch: ReturnType<typeof vi.fn>;
let skipWaitingSpy: ReturnType<typeof vi.fn>;
let cacheAddAll: ReturnType<typeof vi.fn>;
let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

/** Stub the worker-global surface sw.ts touches at import time and during `install`. */
function stubServiceWorkerGlobals(activeWorker: unknown) {
  cacheAddAll = vi.fn().mockResolvedValue(undefined);
  cacheMatch = vi.fn().mockResolvedValue(undefined);
  const fakeCache = {
    addAll: cacheAddAll,
    keys: vi.fn().mockResolvedValue([]),
    match: cacheMatch,
    delete: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal('caches', {
    open: vi.fn().mockResolvedValue(fakeCache),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  });
  vi.stubGlobal('__WB_MANIFEST', []);
  skipWaitingSpy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('skipWaiting', skipWaitingSpy);
  vi.stubGlobal('registration', { active: activeWorker });
  vi.stubGlobal('clients', {
    claim: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([]),
  });

  installHandler = undefined;
  fetchHandler = undefined;
  addEventListenerSpy = vi.spyOn(globalThis, 'addEventListener').mockImplementation(((
    type: string,
    handler,
  ) => {
    if (type === 'install') installHandler = handler as InstallHandler;
    if (type === 'fetch') fetchHandler = handler as FetchHandler;
  }) as typeof globalThis.addEventListener);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  addEventListenerSpy?.mockRestore();
  vi.unstubAllGlobals();
});

describe('src/sw.ts — install handler (fresh install vs. genuine update)', () => {
  it('self-activates on a genuinely fresh install (no prior active worker)', async () => {
    stubServiceWorkerGlobals(null);
    await import('./sw');
    expect(installHandler).toBeTypeOf('function');

    let waited: Promise<unknown> | undefined;
    installHandler!({
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;

    expect(cacheAddAll).toHaveBeenCalled();
    expect(skipWaitingSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT self-activate when an existing worker already controls the scope (a real update stays parked)', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    await import('./sw');

    let waited: Promise<unknown> | undefined;
    installHandler!({
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;

    expect(cacheAddAll).toHaveBeenCalled();
    expect(skipWaitingSpy).not.toHaveBeenCalled();
  });
});

/**
 * The offline fallback (#279). With nothing cached and the network unreachable, handing the app
 * shell to a *navigation* is the whole point of an offline-first PWA — but handing that same HTML
 * to a script request answers a 200 whose body the browser rejects on MIME type, masking the real
 * cause. A subresource must fail cleanly so the app's stale-chunk recovery (lib/stale-chunk-reload)
 * can recognise a missing chunk and reload onto the current build.
 */
describe('src/sw.ts — offline fallback (app shell is for navigations only)', () => {
  /**
   * A minimal stand-in for the request. `new Request(url, { mode: 'navigate' })` is forbidden by
   * the Fetch spec — only the browser may mint a navigation request — so the handler's inputs
   * (`method` / `mode` / `url`) are supplied directly.
   */
  function fakeRequest(url: string, mode: RequestMode): Request {
    return { method: 'GET', mode, url } as Request;
  }

  /** Run one request through the worker's fetch handler with the network down. */
  async function respondOffline(request: Request): Promise<Response> {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await import('./sw');
    let response: Promise<Response> | undefined;
    fetchHandler!({
      request,
      respondWith: (r) => {
        response = r;
      },
    });
    return await response!;
  }

  it('still serves the precached app shell for a navigation', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    cacheMatch.mockResolvedValue(
      new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }),
    );

    const response = await respondOffline(fakeRequest('https://example.test/Gubbins/items', 'navigate'));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('<!doctype html>');
  });

  it('fails an uncached script request cleanly rather than answering it with the app shell', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    // The shell is in the cache, but only ever answers a request for it *by name* — a chunk that
    // has been pruned must not be handed HTML dressed as JavaScript.
    cacheMatch.mockImplementation((key: unknown) =>
      Promise.resolve(
        typeof key === 'string'
          ? new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })
          : undefined,
      ),
    );

    const response = await respondOffline(
      fakeRequest('https://example.test/Gubbins/assets/items-abc123.js', 'cors'),
    );

    expect(response.type).toBe('error');
  });
});
