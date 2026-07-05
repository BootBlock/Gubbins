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
import {
  stashShare,
  parseShareForm,
  pruneStaleShares,
  SHARE_INBOX_CACHE,
} from './features/share/share-inbox';

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * The Web Share Target action path (spec: manifest `share_target.action`, VitePWA config). The
 * PWA has no server, so a "Share to Gubbins" POST lands here and this worker — not a backend —
 * captures it. Resolved against this worker's own URL so it tracks the `/Gubbins/` base path.
 */
const SHARE_TARGET_PATH = new URL('share-target', sw.location.href).pathname;

// `self.__WB_MANIFEST` is the injection point vite-plugin-pwa replaces at build
// time; the cast erases to exactly that token in the emitted worker.
//
// De-duplicate by URL: the injected manifest can list the same asset twice (the
// PWA-manifest icons are emitted both by the precache glob and the webmanifest
// `icons` injection), and `cache.addAll` REJECTS on duplicate requests
// ("Cache.addAll(): duplicate requests") — which would abort `install` and leave the
// worker `redundant`, so no update could ever activate. A `Set` over the URLs keeps
// `addAll` happy while precaching exactly the same asset set.
const PRECACHE_URLS = [
  ...new Set((self as unknown as { __WB_MANIFEST: PrecacheEntry[] }).__WB_MANIFEST.map((entry) => entry.url)),
];

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
  // `registration.active` is only set once some worker has previously controlled this
  // scope. A genuine *update* (one exists) stays waiting until the user accepts the
  // in-app "Reload now" prompt — so a deploy never activates mid-session and never
  // discards unsaved work; the page asks this worker to take over by posting
  // `SKIP_WAITING` (see below). But the very first install ever for this origin has no
  // session to protect, and the app's cross-origin-isolation bootstrap (coi-bootstrap.js)
  // depends on THIS worker activating and reloading the page once before the app can even
  // boot — so it must skip the prompt and activate immediately.
  event.waitUntil(
    (async () => {
      await caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS));
      if (!sw.registration.active) await sw.skipWaiting();
    })(),
  );
});

// The page (workbox-window's `messageSkipWaiting`, driven by usePwaUpdate's "Reload
// now" action) posts `{ type: 'SKIP_WAITING' }` to hand control to this waiting worker.
// `activate` then `clients.claim()`s, which fires `controllerchange` and reloads the
// page onto the new version. This is vite-plugin-pwa's supported `prompt` handshake.
sw.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') {
    void sw.skipWaiting();
  }
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep the app-shell precache and the share inbox; drop any superseded cache. The share
      // inbox holds an in-flight "Share to Gubbins" payload the page has not yet consumed, so an
      // update that activates between the share POST and the draft opening must not discard it.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE && key !== SHARE_INBOX_CACHE).map((key) => caches.delete(key)),
      );
      await pruneStalePrecache();
      // Reclaim any share that was stashed but never consumed (its landing tab was dismissed),
      // while keeping a just-stashed, still-in-flight share.
      await pruneStaleShares();
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
  const url = new URL(event.request.url);
  // A "Share to Gubbins" POST from the OS share sheet: capture it here (the PWA has no server),
  // stash the payload, and redirect to the share-landing route which opens a reviewable draft.
  if (event.request.method === 'POST' && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;
  event.respondWith(respond(event.request));
});

/**
 * Handle an inbound Web Share POST. Reads the `multipart/form-data` the manifest `share_target`
 * declared (`title` / `text` / `url` and an optional `image` file), stashes it under a one-shot id
 * ({@link ./features/share/share-inbox}), and 303-redirects to `share-target?share=<id>` so the SPA
 * opens a **pre-filled add-item draft the user confirms** — a share is never auto-committed. Any
 * failure falls back to opening the empty add flow rather than surfacing a raw error to the OS.
 */
async function handleShareTarget(request: Request): Promise<Response> {
  const landing = new URL('share-target', sw.location.href);
  try {
    const stashed = parseShareForm(await request.formData());
    const id = crypto.randomUUID();
    await stashShare(id, stashed);
    landing.searchParams.set('share', id);
  } catch {
    // Fall through: open the share landing with no id → an empty, still-reviewable draft.
  }
  return Response.redirect(landing.href, 303);
}

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
