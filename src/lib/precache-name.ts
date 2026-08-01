/**
 * Naming for the service worker's app-shell precache — the seam that keeps an *installing*
 * build's bytes out of the cache the *serving* build reads from (issue #499).
 *
 * The precache name used to be a constant shared by every build, so `install` wrote the incoming
 * build's `index.html` and chunks straight into the cache the still-active worker was serving
 * from. `Cache.addAll` has put semantics, so the shell was replaced in place and the new hashed
 * chunks appeared beside the old ones — after which an ordinary refresh silently loaded the new
 * app under the old worker. That bypasses the whole point of the update banner: a build that
 * moves `BASELINE_REVISION` is supposed to warn the user (and offer a backup) *before* it takes
 * over, and instead they landed on the reset screen mid-task having never been asked.
 *
 * Deriving the name from the manifest fixes that by construction: a different build writes to a
 * different cache, so nothing the active worker serves can change until `activate` — which is the
 * step the user's "Reload now" gates. Two structurally identical builds derive the *same* name and
 * so reuse the cache they already populated, which is correct rather than wasteful.
 */

/** One entry of the injected `self.__WB_MANIFEST` — a precached URL and its content revision. */
export interface PrecacheEntry {
  readonly url: string;
  /** Content hash for an unhashed asset (`index.html`); `null` when the URL is itself hashed. */
  readonly revision: string | null;
}

/**
 * Shared prefix of every precache this app has ever named, including the retired constant
 * `gubbins-precache-v1`. Exposed through {@link isPrecacheName} rather than directly: what the
 * worker needs is to recognise *its own* superseded precaches among `caches.keys()` — the one
 * class of cache it may delete without knowing which build wrote it — not the prefix itself.
 */
const PRECACHE_PREFIX = 'gubbins-precache-';

/**
 * FNV-1a over `text`, seeded with `basis`, as an unsigned 32-bit integer.
 *
 * Non-cryptographic on purpose: this distinguishes one build's asset manifest from another's on
 * the same device, and nothing here is a security boundary. Mirrors the arithmetic
 * `db/migrations/migration.ts` uses for the baseline fingerprint — shifts rather than a multiply,
 * so every intermediate stays inside Number's safe-integer range.
 */
function fnv1a(text: string, basis: number): number {
  let hash = basis;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The cache name for the build described by `entries` — {@link PRECACHE_PREFIX} plus a
 * fingerprint of the manifest itself.
 *
 * Both halves of each entry are folded in. The URL alone nearly suffices (Vite content-hashes
 * every chunk it emits), but the app shell and the icons are *not* hashed — they keep a stable
 * URL and carry their content hash in `revision` instead, so hashing URLs alone would give a
 * shell-only change the previous build's name and reintroduce exactly the bug this prevents.
 *
 * Fingerprinted in two passes from different offset bases and concatenated. A collision here is
 * not a cosmetic near-miss — two different builds would share a cache, and the
 * install-into-the-live-cache bug would be back for that pair — so a second pass is worth its
 * one extra loop over a few hundred short strings: two manifests have to collide under *both*
 * bases to be confused. That is not the 64 bits the name's length suggests (the passes differ
 * only in where they start, so they are not independent), but it is far beyond what
 * distinguishing consecutive builds of one app needs.
 */
export function precacheCacheName(entries: readonly PrecacheEntry[]): string {
  // ` ` separates the fields and `\n` the entries: neither can occur in a URL or a hex
  // revision, so no two distinct manifests can flatten to the same string.
  const flattened = entries.map((entry) => `${entry.url} ${entry.revision ?? ''}`).join('\n');
  // 0x811c9dc5 is the standard FNV-1a 32-bit offset basis; the second lane uses a different
  // basis so the two are not the same function of the input.
  const low = fnv1a(flattened, 0x811c9dc5);
  const high = fnv1a(flattened, 0x01000193);
  return `${PRECACHE_PREFIX}${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/** True when `name` is one of this app's precaches — the current build's or a superseded one. */
export function isPrecacheName(name: string): boolean {
  return name.startsWith(PRECACHE_PREFIX);
}

/** What `install` should fetch for one manifest entry: an absolute URL and an HTTP-cache mode. */
export interface PrecacheRequestSpec {
  readonly url: string;
  readonly cache: RequestCache;
}

/**
 * How to fetch one manifest entry, resolved against `scope` (the service worker's own location,
 * so the cache keys are absolute and track the `/Gubbins/` base path).
 *
 * An entry that carries a `revision` has an **unhashed** URL — the app shell and the PWA-manifest
 * icons keep a stable path and record their content hash here instead — so the HTTP cache may
 * well hold the *previous* build's bytes for it, and GitHub Pages serves HTML with a finite
 * `max-age`. Precaching that copy would pair the old shell with this build's chunks: a page whose
 * entry `<script type="module">` 404s once the old build's chunks are swept, which the app's
 * stale-chunk recovery does not cover (it listens for `vite:preloadError` from dynamic imports).
 * So those fetches bypass the HTTP cache with `'reload'`.
 *
 * A `revision: null` entry is one whose URL already carries its content hash, and is fetched
 * normally: the URL *is* the fingerprint, so a cached copy cannot be the wrong bytes, and forcing
 * a re-download would cost megabytes of WASM and chunks on every update — over a metered
 * connection — to arrive at the identical file.
 */
export function precacheRequestSpec(entry: PrecacheEntry, scope: string | URL): PrecacheRequestSpec {
  return {
    url: new URL(entry.url, scope).href,
    cache: entry.revision === null ? 'default' : 'reload',
  };
}
