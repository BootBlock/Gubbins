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
import { buildContentSecurityPolicy, withCspMeta, toCspOrigin } from './csp';
import { BRIDGE_ORIGIN_MESSAGE } from './lib/bridge-connect-policy';
import {
  stashShare,
  parseShareForm,
  pruneStaleShares,
  SHARE_INBOX_CACHE,
} from './features/share/share-inbox';
import { OCR_ASSET_CACHE, isOcrAssetUrl } from './features/inventory/ocr/ocr-asset-cache';
import {
  REMINDER_CLICK_MESSAGE,
  REMINDER_SYNC_MESSAGE,
  REMINDER_FALLBACK_ROUTE,
  REMINDER_PERIODIC_SYNC_TAG,
} from './features/alerts/reminder-messages';

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
 * Where the user's bridge origin is kept so it survives this worker being terminated between
 * events. Its own cache, not the precache: {@link pruneStalePrecache} deletes anything the
 * build manifest doesn't name, which is every entry here.
 */
const BRIDGE_ORIGIN_CACHE = 'gubbins-bridge-origin-v1';
/** Relative, so it resolves against this worker's scope like every other cached request. */
const BRIDGE_ORIGIN_KEY = 'bridge-origin';

/**
 * The registered bridge origin, memoised for this worker's lifetime — `undefined` until first
 * read, then the validated origin or `null`. Every response consults it, so the alternative is
 * a CacheStorage round-trip per subresource.
 */
let bridgeOrigin: string | null | undefined;

/**
 * The user's bridge origin, if they have registered one (issue #385).
 *
 * Re-validated on the way out as well as in: the stored value has been through CacheStorage,
 * and {@link buildContentSecurityPolicy} splicing an unvalidated string into a policy is the
 * one way this mechanism could weaken rather than extend it.
 */
async function readBridgeOrigin(): Promise<string | null> {
  if (bridgeOrigin !== undefined) return bridgeOrigin;
  try {
    const cache = await caches.open(BRIDGE_ORIGIN_CACHE);
    const stored = await cache.match(BRIDGE_ORIGIN_KEY);
    bridgeOrigin = stored ? toCspOrigin(await stored.text()) : null;
  } catch {
    bridgeOrigin = null;
  }
  return bridgeOrigin;
}

/** Store (or, for anything that isn't a usable origin, forget) the origin the page registered. */
async function storeBridgeOrigin(value: unknown): Promise<void> {
  const origin = typeof value === 'string' ? toCspOrigin(value) : null;
  bridgeOrigin = origin;
  const cache = await caches.open(BRIDGE_ORIGIN_CACHE);
  if (origin === null) await cache.delete(BRIDGE_ORIGIN_KEY);
  else await cache.put(BRIDGE_ORIGIN_KEY, new Response(origin));
}

/**
 * Defence-in-depth Content-Security-Policy injected on responses in production (this
 * worker is disabled in dev, so Vite's HMR — which needs inline/eval/ws — is untouched).
 * The policy is the single source of truth in {@link buildContentSecurityPolicy};
 * `script-src` carries **no `'unsafe-inline'`** — the app ships no inline scripts — only
 * `'self'` + `'wasm-unsafe-eval'` for the SQLite WASM module.
 *
 * `connect-src` additionally carries the user's own bridge origin when they have registered
 * one (issue #385). Because a browser enforces the **intersection** of every delivered
 * policy, adding it here is not enough on its own — the app shell's build-time `<meta>` would
 * veto it — so {@link respond} rewrites that meta with the matching policy on the way out.
 * Both forms come from the same call, so they cannot drift.
 */
function contentSecurityPolicy(origin: string | null, forMeta = false): string {
  return buildContentSecurityPolicy({ forMeta, bridgeOrigin: origin });
}

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
//
// The page also registers the user's bridge origin here (issue #385) so `connect-src` can
// name it. That one is **acknowledged** on the reply port before resolving: the page reloads
// straight afterwards to pick up the new policy, and reloading before the origin was stored
// would serve the old one and need a second reload.
sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string; origin?: unknown } | null;
  if (data?.type === 'SKIP_WAITING') {
    void sw.skipWaiting();
    return;
  }
  if (data?.type === BRIDGE_ORIGIN_MESSAGE) {
    const reply = (event as unknown as { ports?: readonly MessagePort[] }).ports?.[0];
    (event as unknown as ExtendableEvent).waitUntil(
      storeBridgeOrigin(data.origin)
        // A CacheStorage failure is still worth acknowledging: the page's only use for the
        // reply is to time its reload, and leaving it to time out helps nobody.
        .catch(() => undefined)
        .then(() => reply?.postMessage({ ok: true })),
    );
  }
});

/** The `data` payload a reminder notification carries — its deep-link target (G3). */
interface ReminderNotificationData {
  readonly target?: { readonly route?: string; readonly itemId?: string; readonly itemName?: string };
}

// A local reminder notification (G3) was clicked. Focus an already-open window and post the
// alert's target so the app deep-links to it (seed search + flash the item); if none is open,
// open a new one at the target route. Notifications are shown by this worker
// (`registration.showNotification`), so this worker is where their clicks land.
sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data as ReminderNotificationData | null) ?? {};
  const target = data.target;
  const route = target?.route && target.route.length > 0 ? target.route : REMINDER_FALLBACK_ROUTE;
  // Resolve against this worker's own URL so the link tracks the `/Gubbins/` base path.
  const url = new URL(route.replace(/^\/+/, ''), sw.location.href).href;
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client): client is WindowClient => 'focus' in client);
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: REMINDER_CLICK_MESSAGE, target });
        return;
      }
      await sw.clients.openWindow(url);
    })(),
  );
});

// Periodic Background Sync wake (G3, best-effort, where the platform supports it). This worker
// cannot compute alerts — the inventory database is only reachable from the app — so it asks any
// live (possibly backgrounded) window to re-check its alert feeds so fresh reminders can fire.
// A no-op where the app is fully closed; true no-client background delivery needs a server (the
// deferred Web Push path). `periodicsync` is not in the TS SW lib, so the listener is added via a
// widened view of the global scope.
(
  sw as unknown as {
    addEventListener(
      type: 'periodicsync',
      listener: (event: ExtendableEvent & { tag: string }) => void,
    ): void;
  }
).addEventListener('periodicsync', (event) => {
  if (event.tag !== REMINDER_PERIODIC_SYNC_TAG) return;
  event.waitUntil(
    (async () => {
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: REMINDER_SYNC_MESSAGE });
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep the app-shell precache, the share inbox and the OCR runtime cache; drop any
      // superseded cache. The share inbox holds an in-flight "Share to Gubbins" payload the page
      // has not yet consumed, so an update that activates between the share POST and the draft
      // opening must not discard it. The OCR cache is what keeps the opt-in, precache-excluded
      // OCR assets available offline (#159); its name carries the Tesseract generation, so an
      // upgrade is swept here as a *superseded* cache rather than served stale. The bridge-origin
      // cache holds the one user-supplied value the CSP needs (issue #385) — sweeping it would
      // silently re-block the bridge on every deploy.
      const keys = await caches.keys();
      const keep = new Set([CACHE, SHARE_INBOX_CACHE, OCR_ASSET_CACHE, BRIDGE_ORIGIN_CACHE]);
      await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
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
 * `respond()` never writes to *this* cache — the one thing it does cache at runtime, the OCR
 * assets, goes to its own {@link OCR_ASSET_CACHE} precisely so this stays true — so it holds
 * exactly the precached set: anything no longer named by the current manifest is stale and safe
 * to delete. URLs are resolved against `sw.location` — the identical base `addAll` uses — so the
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
  // The opt-in OCR assets are precache-excluded (they are several MB), so they get their own
  // cache-first runtime cache — otherwise the feature is unusable offline however often it has
  // been used, and re-downloads megabytes on every use (#159).
  if (isOcrAssetUrl(new URL(request.url), sw.location.href)) return respondOcrAsset(request);

  const origin = await readBridgeOrigin();
  const policy = contentSecurityPolicy(origin);
  const cache = await caches.open(CACHE);

  // SPA navigations resolve to the precached app shell (offline-first).
  if (request.mode === 'navigate') {
    const index = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (index) return withIsolationHeaders(await withBridgeOriginMeta(index, origin), policy);
  }

  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return withIsolationHeaders(cached, policy);

  try {
    const network = await fetch(request);
    return withIsolationHeaders(
      request.mode === 'navigate' ? await withBridgeOriginMeta(network, origin) : network,
      policy,
    );
  } catch {
    // Offline, and nothing cached. This is only ever a *subresource* — a navigation has already
    // been answered from the precached shell above, and if that shell were missing this same
    // lookup could not find it either. Handing the shell to a script or image request answers a
    // 200 with HTML, which the browser rejects on MIME type anyway while hiding the real cause,
    // so fail cleanly instead: that is what lets the app recognise a missing chunk and reload
    // onto the current build (see lib/stale-chunk-reload.ts).
    return Response.error();
  }
}

/**
 * Serve a staged OCR asset cache-first, populating {@link OCR_ASSET_CACHE} on the way through.
 *
 * Cache-first rather than stale-while-revalidate: these files are large, unhashed and change only
 * with a Tesseract upgrade — which mints a new cache name — so a background revalidation would
 * re-download megabytes on a metered connection to learn nothing. A response is only stored when
 * it is a complete 200: `cache.put` rejects a 206, and caching an error page would poison the
 * feature until the next generation bump.
 *
 * The `put` is **awaited** rather than fired and forgotten: once the response promise settles the
 * browser is free to terminate this worker, which would abandon a half-written multi-megabyte
 * entry and leave the asset uncached — the exact bug this function exists to fix. There is no
 * `event` here to hold open with `waitUntil`, so awaiting is what keeps the worker alive.
 */
async function respondOcrAsset(request: Request): Promise<Response> {
  const policy = contentSecurityPolicy(await readBridgeOrigin());
  const cache = await caches.open(OCR_ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return withIsolationHeaders(cached, policy);

  try {
    const response = await fetch(request);
    if (response.status === 200) await cache.put(request, response.clone());
    return withIsolationHeaders(response, policy);
  } catch {
    // Offline with nothing cached: the engine has never run here. Fail cleanly so the OCR
    // dialog surfaces its own "assets unavailable" path rather than a mis-typed app shell.
    return Response.error();
  }
}

/**
 * Rewrite the app shell's CSP `<meta>` so it names the user's bridge origin too (issue #385).
 *
 * Without this the header form below would be pointless: a browser enforces the intersection of
 * every delivered policy, so the build-time meta — which cannot know an address the user typed
 * after the build — would veto the origin however permissive the header is.
 *
 * Only ever applied to the HTML shell: anything else is returned untouched rather than buffered
 * into a string. A document already in flight keeps the policy it loaded with, so a *newly*
 * registered origin takes effect on the next navigation — which is what the app's "reload to
 * connect" notice is for.
 */
async function withBridgeOriginMeta(response: Response, origin: string | null): Promise<Response> {
  if (origin === null || response.status === 0) return response;
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    return response;
  }
  const html = withCspMeta(await response.text(), contentSecurityPolicy(origin, true));
  // The rewritten shell is a different length from the one that was cached, so the original
  // `Content-Length` (and any `Content-Encoding`) would describe a body that no longer exists —
  // a truncated or rejected document. Drop both and let the new body speak for itself.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

/** Clone a response with the cross-origin isolation headers and the policy added (spec §2.2.6). */
function withIsolationHeaders(response: Response, policy: string): Response {
  if (response.status === 0) return response; // opaque/error — leave untouched
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Content-Security-Policy', policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
