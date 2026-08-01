import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OCR_ASSET_CACHE } from './features/inventory/ocr/ocr-asset-cache';
import { precacheCacheName, type PrecacheEntry } from './lib/precache-name';

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
type MessageHandler = (event: {
  data: unknown;
  ports?: readonly { postMessage: (value: unknown) => void }[];
  waitUntil: (p: Promise<unknown>) => void;
}) => void;

let installHandler: InstallHandler | undefined;
let activateHandler: InstallHandler | undefined;
let fetchHandler: FetchHandler | undefined;
let messageHandler: MessageHandler | undefined;
let cacheMatch: ReturnType<typeof vi.fn>;
let bridgeOriginMatch: ReturnType<typeof vi.fn>;
let swStateMatch: ReturnType<typeof vi.fn>;
let swStatePut: ReturnType<typeof vi.fn>;
let skipWaitingSpy: ReturnType<typeof vi.fn>;
let cacheAddAll: ReturnType<typeof vi.fn>;
let cachePut: ReturnType<typeof vi.fn>;
let cacheDelete: ReturnType<typeof vi.fn>;
let cachesOpen: ReturnType<typeof vi.fn>;
let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

/** The bridge-origin cache's name, kept in step with sw.ts (issue #385). */
const BRIDGE_ORIGIN_CACHE = 'gubbins-bridge-origin-v1';
/** The worker's own state cache, kept in step with sw.ts (issue #499). */
const SW_STATE_CACHE = 'gubbins-sw-state-v1';

/** Stub the worker-global surface sw.ts touches at import time and during `install`. */
function stubServiceWorkerGlobals(activeWorker: unknown, manifest: readonly PrecacheEntry[] = []) {
  cacheAddAll = vi.fn().mockResolvedValue(undefined);
  cacheMatch = vi.fn().mockResolvedValue(undefined);
  bridgeOriginMatch = vi.fn().mockResolvedValue(undefined);
  swStateMatch = vi.fn().mockResolvedValue(undefined);
  swStatePut = vi.fn().mockResolvedValue(undefined);
  cachePut = vi.fn().mockResolvedValue(undefined);
  cacheDelete = vi.fn().mockResolvedValue(true);
  const fakeCache = {
    addAll: cacheAddAll,
    keys: vi.fn().mockResolvedValue([]),
    match: cacheMatch,
    put: cachePut,
    delete: cacheDelete,
  };
  // The bridge-origin lookup every response makes (issue #385) gets its **own** `match`, exactly
  // as it gets its own cache in the worker. Sharing one mock would let a single stubbed Response
  // answer both lookups — and the first reader consumes its body, so the second would be served
  // an already-used one and the test would pass for the wrong reason. The in-service precache
  // record (issue #499) gets its own pair for the same reason.
  const bridgeOriginCache = { ...fakeCache, match: bridgeOriginMatch };
  const swStateCache = { ...fakeCache, match: swStateMatch, put: swStatePut };
  cachesOpen = vi.fn((name: string) => {
    if (name === BRIDGE_ORIGIN_CACHE) return Promise.resolve(bridgeOriginCache);
    if (name === SW_STATE_CACHE) return Promise.resolve(swStateCache);
    return Promise.resolve(fakeCache);
  });
  vi.stubGlobal('caches', {
    open: cachesOpen,
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  });
  vi.stubGlobal('__WB_MANIFEST', manifest);
  skipWaitingSpy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('skipWaiting', skipWaitingSpy);
  vi.stubGlobal('registration', { active: activeWorker });
  vi.stubGlobal('clients', {
    claim: vi.fn().mockResolvedValue(undefined),
    matchAll: vi.fn().mockResolvedValue([]),
  });

  installHandler = undefined;
  fetchHandler = undefined;
  activateHandler = undefined;
  messageHandler = undefined;
  addEventListenerSpy = vi.spyOn(globalThis, 'addEventListener').mockImplementation(((
    type: string,
    handler,
  ) => {
    if (type === 'install') installHandler = handler as InstallHandler;
    if (type === 'fetch') fetchHandler = handler as FetchHandler;
    if (type === 'activate') activateHandler = handler as InstallHandler;
    if (type === 'message') messageHandler = handler as MessageHandler;
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
 * Per-build precache naming (issue #499).
 *
 * The precache used to be a constant every build shared, so `install` wrote the incoming build's
 * shell and chunks straight into the cache the still-active worker was serving from. `addAll` has
 * put semantics, so `index.html` was replaced in place and the new hashed chunks landed beside the
 * old ones — after which an ordinary F5 loaded the new app under the old worker, with no banner,
 * no accepted update and, crucially, no reset warning for a build that moves `BASELINE_REVISION`.
 * The user arrived at "reset your data to continue" mid-task having never been offered a backup.
 *
 * These pin down the structural fix: the name is derived from the build's own manifest, so an
 * installing build cannot touch the running one's bytes; the swap happens on `activate`, the step
 * the user's "Reload now" actually gates; and the caches that swap leaves behind are bounded
 * without ever risking the one being served.
 */
describe('src/sw.ts — an installing build precaches into its own cache, never the live one', () => {
  /** A plausible manifest: the unhashed shell, plus one content-hashed chunk. */
  const MANIFEST: readonly PrecacheEntry[] = [
    { url: 'index.html', revision: 'a1b2c3d4' },
    { url: 'assets/index-9f8e7d6c.js', revision: null },
  ];
  /** The cache the build described by {@link MANIFEST} owns. */
  const THIS_BUILD = precacheCacheName(MANIFEST);
  /** The constant name every build shared before this fix — now just another superseded cache. */
  const RETIRED = 'gubbins-precache-v1';

  /** Re-stub `caches` with a fixed key set, collecting every name the worker deletes. */
  function trackDeletes(keys: readonly string[]): string[] {
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      open: cachesOpen,
      keys: vi.fn().mockResolvedValue([...keys]),
      delete: vi.fn((key: string) => {
        deleted.push(key);
        return Promise.resolve(true);
      }),
    });
    return deleted;
  }

  /** Drive one lifecycle handler to completion. */
  async function run(handler: InstallHandler | undefined): Promise<void> {
    let waited: Promise<unknown> | undefined;
    handler!({
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;
  }

  it('precaches into a cache named for this build, not a name another build could be serving', async () => {
    stubServiceWorkerGlobals({ state: 'activated' }, MANIFEST);
    await import('./sw');

    await run(installHandler);

    expect(cachesOpen.mock.calls.flat()).toContain(THIS_BUILD);
    expect(cachesOpen.mock.calls.flat()).not.toContain(RETIRED);
    // Resolved against the worker's own location, so the keys are absolute and track the base path.
    const requested = (cacheAddAll.mock.calls[0]![0] as Request[]).map((request) => request.url);
    expect(requested).toEqual([
      new URL('index.html', globalThis.location.href).href,
      new URL('assets/index-9f8e7d6c.js', globalThis.location.href).href,
    ]);
  });

  it('swaps caches on activate — the previous build’s precache goes, and this one is recorded as live', async () => {
    stubServiceWorkerGlobals({ state: 'activated' }, MANIFEST);
    const deleted = trackDeletes([RETIRED, THIS_BUILD, BRIDGE_ORIGIN_CACHE, SW_STATE_CACHE]);
    await import('./sw');

    await run(activateHandler);

    // Activate is the first moment the old cache is safe to drop: the clients it was serving are
    // about to be claimed onto this build.
    expect(deleted).toEqual([RETIRED]);
    // Recorded only here, never at install: a worker that is merely installed may never be
    // accepted, and claiming to be live would let the *next* build delete the running app's cache.
    expect(swStatePut).toHaveBeenCalledTimes(1);
    expect(swStatePut.mock.calls[0]![0]).toBe('in-service-precache');
    await expect((swStatePut.mock.calls[0]![1] as Response).text()).resolves.toBe(THIS_BUILD);
  });

  it('sweeps an abandoned update’s precache on install, while leaving the live one alone', async () => {
    // The user ignored the banner, so the build in between was never accepted and its fully
    // populated cache would otherwise linger against the storage quota forever.
    const LIVE = 'gubbins-precache-1111111122222222';
    const ABANDONED = 'gubbins-precache-3333333344444444';
    stubServiceWorkerGlobals({ state: 'activated' }, MANIFEST);
    swStateMatch.mockResolvedValue(new Response(LIVE));
    const deleted = trackDeletes([LIVE, ABANDONED, THIS_BUILD, OCR_ASSET_CACHE, SW_STATE_CACHE]);
    await import('./sw');

    await run(installHandler);

    expect(deleted).toEqual([ABANDONED]);
  });

  it('deletes nothing on install when no live precache has been recorded', async () => {
    // The build that ships this fix installs beside a worker still serving `gubbins-precache-v1`,
    // and no activate has ever recorded a name. Deleting on a guess would blank the running app —
    // offline, it could not even recover — so the sweep waits for the next activate, which drops
    // every superseded cache anyway.
    stubServiceWorkerGlobals({ state: 'activated' }, MANIFEST);
    const deleted = trackDeletes([RETIRED, THIS_BUILD]);
    await import('./sw');

    await run(installHandler);

    expect(deleted).toEqual([]);
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

/**
 * The OCR runtime cache (#159). Tesseract's worker, WASM cores and language models are several MB
 * and deliberately excluded from the precache, so before this they were re-fetched on every use —
 * leaving an opt-in feature unusable offline however often it had been used, in exactly the
 * no-signal context the app is built for, and re-downloading megabytes on metered connections.
 */
describe('src/sw.ts — OCR assets are cached at runtime, in their own cache', () => {
  function fakeRequest(url: string): Request {
    return { method: 'GET', mode: 'cors', url } as Request;
  }

  /** An OCR asset URL under whatever base this worker is deployed at. */
  function ocrAsset(name: string): string {
    return new URL(`ocr/${name}`, globalThis.location.href).href;
  }

  /** Run one request through the worker's fetch handler with a given network outcome. */
  async function respondWith(request: Request, network: () => Promise<Response>): Promise<Response> {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => network()),
    );
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

  it('stores a freshly-fetched OCR asset in the dedicated OCR cache, not the precache', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });

    const response = await respondWith(
      fakeRequest(ocrAsset('worker.min.js')),
      async () => new Response('/* tesseract worker */', { headers: { 'Content-Type': 'text/javascript' } }),
    );

    expect(response.status).toBe(200);
    // Exactly two caches are opened — the read-only bridge-origin lookup every response makes,
    // and the OCR one this asset belongs in. Asserted as the *whole set* rather than as "not the
    // precache": naming the precache would go quietly vacuous the day its name changes (it is
    // derived per build — issue #499), and the invariant being guarded is that this path leaves
    // the precache holding precisely the build manifest it is named after.
    expect(cachesOpen.mock.calls.flat()).toEqual([BRIDGE_ORIGIN_CACHE, OCR_ASSET_CACHE]);
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it('serves a previously-used OCR asset offline, without touching the network', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    cacheMatch.mockResolvedValue(new Response('/* tesseract worker */'));
    const network = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const response = await respondWith(fakeRequest(ocrAsset('tessdata-fast/eng.traineddata')), network);

    expect(response.status).toBe(200);
    expect(network).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('does not cache a failed fetch, so one bad response cannot poison the feature', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });

    const response = await respondWith(
      fakeRequest(ocrAsset('worker.min.js')),
      async () => new Response('not found', { status: 404 }),
    );

    expect(response.status).toBe(404);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('keeps the OCR cache when a new version activates', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      open: cachesOpen,
      keys: vi
        .fn()
        .mockResolvedValue(['gubbins-precache-v1', OCR_ASSET_CACHE, 'gubbins-ocr-assets-0.0.0-old']),
      delete: vi.fn((key: string) => {
        deleted.push(key);
        return Promise.resolve(true);
      }),
    });
    await import('./sw');

    let waited: Promise<unknown> | undefined;
    activateHandler!({
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;

    expect(deleted).not.toContain(OCR_ASSET_CACHE);
    // A superseded generation (an older Tesseract) IS swept, so stale assets never linger against
    // the storage quota — and a mismatched worker is never served to the newly-bundled library.
    expect(deleted).toContain('gubbins-ocr-assets-0.0.0-old');
  });
});

/**
 * The user's own bridge origin in `connect-src` (issue #385).
 *
 * Push-to-bridge and the scale reading fetch an address only the user knows, which the committed
 * policy cannot name — so in a production build the browser blocked them before they left the
 * page, and the app reported a running bridge as an unreachable one. This worker is the only
 * thing that can widen the policy, and it must widen **both** delivered forms: a browser enforces
 * their intersection, so a permissive header the shell's `<meta>` does not also permit changes
 * nothing. These tests pin down that pairing, and that a stored value which is not a bare origin
 * can never edit the policy rather than extend it.
 */
describe('src/sw.ts — the registered bridge origin reaches both delivered CSP forms', () => {
  const BRIDGE = 'http://gubbins-bridge.test:8787';
  const SHELL_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';

  function fakeRequest(url: string, mode: RequestMode): Request {
    return { method: 'GET', mode, url } as Request;
  }

  /** Serve a navigation with `stored` sitting in the bridge-origin cache. */
  async function navigate(stored: string | null): Promise<Response> {
    stubServiceWorkerGlobals({ state: 'activated' });
    if (stored !== null) bridgeOriginMatch.mockResolvedValue(new Response(stored));
    cacheMatch.mockResolvedValue(
      new Response(`<!doctype html><html><head>${SHELL_META}</head><body></body></html>`, {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await import('./sw');

    let response: Promise<Response> | undefined;
    fetchHandler!({
      request: fakeRequest('https://app.example.test/Gubbins/items', 'navigate'),
      respondWith: (r) => {
        response = r;
      },
    });
    return await response!;
  }

  it('adds the origin to the response header AND rewrites the shell meta to match', async () => {
    const response = await navigate(BRIDGE);
    const html = await response.text();

    expect(response.headers.get('Content-Security-Policy')).toContain(`connect-src 'self' `);
    expect(response.headers.get('Content-Security-Policy')).toContain(BRIDGE);
    // The meta the browser actually parses carries it too — without this the header is inert.
    expect(html).toContain(`content="`);
    expect(html).toContain(BRIDGE);
    expect(html).not.toContain(SHELL_META);
    // A `<meta>` cannot express frame-ancestors; the header still must.
    expect(html).not.toContain('frame-ancestors');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('serves the committed policy untouched when no origin has been registered', async () => {
    const response = await navigate(null);
    const html = await response.text();

    expect(response.headers.get('Content-Security-Policy')).toContain(
      "connect-src 'self' https://www.googleapis.com https://world.openfoodfacts.org https://www.wikidata.org https://query.wikidata.org;",
    );
    // Nothing to add, so the shell is passed through as precached rather than re-serialised.
    expect(html).toContain(SHELL_META);
  });

  it('ignores a stored value that is not a bare origin, so it can never edit the policy', async () => {
    const response = await navigate("http://evil.test; script-src 'unsafe-inline' *");

    const header = response.headers.get('Content-Security-Policy') ?? '';
    expect(header).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(header).not.toContain('evil.test');
    expect(await response.text()).toContain(SHELL_META);
  });

  it('stores the origin the page registers and acknowledges it on the reply port', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    await import('./sw');
    expect(messageHandler).toBeTypeOf('function');

    const acks: unknown[] = [];
    let waited: Promise<unknown> | undefined;
    messageHandler!({
      data: { type: 'SET_BRIDGE_ORIGIN', origin: `${BRIDGE}/api/v1/snapshot` },
      ports: [{ postMessage: (value) => acks.push(value) }],
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;

    expect(cachePut).toHaveBeenCalledTimes(1);
    await expect((cachePut.mock.calls[0]![1] as Response).text()).resolves.toBe(BRIDGE);
    // The page reloads the moment this resolves, so an unacknowledged store would cost it a
    // second reload to pick up the policy.
    expect(acks).toEqual([{ ok: true }]);
  });

  it('forgets the origin when the page clears the bridge URL', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    await import('./sw');

    let waited: Promise<unknown> | undefined;
    messageHandler!({
      data: { type: 'SET_BRIDGE_ORIGIN', origin: '' },
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;

    expect(cachePut).not.toHaveBeenCalled();
    expect(cacheDelete).toHaveBeenCalledWith('bridge-origin');
  });

  it('keeps the bridge-origin cache when a new version activates', async () => {
    stubServiceWorkerGlobals({ state: 'activated' });
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      open: cachesOpen,
      keys: vi.fn().mockResolvedValue(['gubbins-precache-v1', BRIDGE_ORIGIN_CACHE, 'stale']),
      delete: vi.fn((key: string) => {
        deleted.push(key);
        return Promise.resolve(true);
      }),
    });
    await import('./sw');

    let waited: Promise<unknown> | undefined;
    activateHandler!({
      waitUntil: (p) => {
        waited = p;
      },
    });
    await waited;

    // Sweeping it would silently re-block the bridge on every deploy — and the app would report
    // it as an outage rather than as something a reload fixes.
    expect(deleted).not.toContain(BRIDGE_ORIGIN_CACHE);
    expect(deleted).toContain('stale');
  });
});
