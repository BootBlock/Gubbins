/// <reference lib="webworker" />
/**
 * Gubbins service worker — vite-plugin-pwa (injectManifest strategy).
 *
 * One worker, two responsibilities:
 *   1. Offline-first precaching of the app shell (spec §2, §2.4.5).
 *   2. Injecting COOP/COEP (+ CORP) headers on every response, so SharedArrayBuffer
 *      and the SQLite OPFS VFS work on static hosts that cannot set headers — e.g.
 *      GitHub Pages (spec §2.2.6). This replaces a standalone coi-serviceworker,
 *      which would otherwise fight this worker for control of the scope.
 *
 * injectManifest is vite-plugin-pwa's supported mechanism for the custom fetch
 * logic header-injection requires (generateSW cannot express it).
 */
import { buildContentSecurityPolicy } from './csp';

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const sw = self as unknown as ServiceWorkerGlobalScope;

// `self.__WB_MANIFEST` is the injection point vite-plugin-pwa replaces at build
// time; the cast erases to exactly that token in the emitted worker.
const PRECACHE_URLS = (self as unknown as { __WB_MANIFEST: PrecacheEntry[] }).__WB_MANIFEST.map(
  (entry) => entry.url,
);

const CACHE = 'gubbins-precache-v1';
const INDEX_URL = 'index.html';

/**
 * Defence-in-depth Content-Security-Policy injected on responses in production (this
 * worker is disabled in dev, so Vite's HMR — which needs inline/eval/ws — is untouched).
 * The policy is the single source of truth in {@link buildContentSecurityPolicy}; a
 * build-only `<meta>` form mirrors it on the very first navigation before this worker is
 * in control. `script-src` carries **no `'unsafe-inline'`** — the app ships no inline
 * scripts — only `'self'` + `'wasm-unsafe-eval'` for the SQLite WASM module.
 */
const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

sw.addEventListener('install', (event) => {
  // Deliberately NOT skipWaiting() here. Under the `prompt` update flow a new worker
  // installs but stays *waiting* until the user accepts the in-app "Reload now" prompt
  // — so a deploy never activates mid-session and never discards unsaved work. The
  // page asks this worker to take over by posting `SKIP_WAITING` (see below).
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});

// The page (workbox-window's `messageSkipWaiting`, driven by usePwaUpdate's "Reload
// now" action) posts `{ type: 'SKIP_WAITING' }` to hand control to this waiting worker.
// `activate` then `clients.claim()`s, which fires `controllerchange` and reloads the
// page onto the new version. This is vite-plugin-pwa's supported `prompt` handshake.
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    sw.skipWaiting();
  }
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await pruneStalePrecache();
      await sw.clients.claim();
    })(),
  );
});

/**
 * Drop precache entries left behind by previous deploys. The cache name is stable
 * across releases (so the offline shell survives an update), and every build emits
 * new content-hashed asset URLs, so `install`'s `addAll` only ever *adds* to this
 * cache — superseded chunks would otherwise linger forever, growing CacheStorage on
 * each deploy and eating into the same storage quota the app meters (spec §7.6).
 *
 * `respond()` never writes to the cache, so it holds exactly the precached set:
 * anything no longer named by the current manifest is stale and safe to delete. URLs
 * are resolved against `sw.location` — the identical base `addAll` uses — so the
 * comparison matches the cached requests regardless of relative/absolute manifest form.
 */
async function pruneStalePrecache(): Promise<void> {
  const cache = await caches.open(CACHE);
  const wanted = new Set(PRECACHE_URLS.map((url) => new URL(url, sw.location.href).href));
  const cached = await cache.keys();
  await Promise.all(
    cached.filter((request) => !wanted.has(request.url)).map((request) => cache.delete(request)),
  );
}

sw.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(respond(event.request));
});

async function respond(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);

  // SPA navigations resolve to the precached app shell (offline-first).
  if (request.mode === 'navigate') {
    const index = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (index) return withIsolationHeaders(index);
  }

  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return withIsolationHeaders(cached);

  try {
    return withIsolationHeaders(await fetch(request));
  } catch {
    const fallback = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (fallback) return withIsolationHeaders(fallback);
    return Response.error();
  }
}

/** Clone a response with the cross-origin isolation headers added (spec §2.2.6). */
function withIsolationHeaders(response: Response): Response {
  if (response.status === 0) return response; // opaque/error — leave untouched
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
