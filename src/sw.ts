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
 * Defence-in-depth Content-Security-Policy injected on responses in production
 * (this worker is disabled in dev, so Vite's HMR — which needs inline/eval/ws — is
 * untouched). Deliberately pragmatic for a local-first PWA rather than maximally
 * strict:
 *   - `worker-src 'self' blob:` — the SQLite database worker (the directive a
 *     foreign report-only policy was flagging).
 *   - `script-src` keeps `'unsafe-inline'` for the COOP/COEP bootstrap + the PWA
 *     registration snippet, and `'wasm-unsafe-eval'` so the SQLite WASM module can
 *     instantiate.
 *   - `connect-src 'self'` is correct while fully local; Phase 7 cloud sync will
 *     broaden it to the chosen provider's origin.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

sw.addEventListener('install', (event) => {
  sw.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await sw.clients.claim();
    })(),
  );
});

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
