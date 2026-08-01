/**
 * The runtime cache the on-device OCR assets live in — the seam shared by the service worker
 * ({@link ../../../sw}) and the OCR engine ({@link ./ocr-engine}).
 *
 * Tesseract's worker script, WASM cores and language models are served from our own origin under
 * `ocr/`, but are deliberately kept **out** of the precache (`injectManifest.globIgnores` in
 * vite.config.ts): they are several MB and belong to an opt-in feature most installs never touch,
 * so precaching them would bloat the base offline shell for everyone. Without a runtime cache,
 * though, they are re-fetched from the network on *every* use — so the feature simply stops
 * working offline no matter how often it has been used, and re-downloads megabytes on a metered
 * connection each time (#159).
 *
 * Hence a **separate, cache-first cache**: the assets land here on first use and are served from
 * here forever after, while the precache still holds exactly the build manifest it is named after
 * — and so survives no longer than the build that wrote it.
 *
 * The cache name carries {@link OCR_ASSET_GENERATION} because these files are *unhashed* — a
 * Tesseract upgrade republishes `worker.min.js` and the cores at the same URLs, and a stale worker
 * paired with the newly-bundled library is a broken engine. Bumping the generation names a new
 * cache; the worker's `activate` prune deletes every cache it does not keep, so the superseded
 * assets are swept on the next update rather than lingering against the storage quota.
 */

/**
 * Bumped whenever the staged OCR assets change — i.e. when `tesseract.js` or `tesseract.js-core`
 * is upgraded (see scripts/setup-ocr-assets.mjs, which stages their dist files verbatim). This is
 * the installed Tesseract version; `ocr-asset-cache.test.ts` asserts it still matches the dependency
 * so an upgrade that forgets to bump it fails the build rather than serving a mismatched worker.
 */
export const OCR_ASSET_GENERATION = '7.0.0';

/** Dedicated runtime cache the OCR assets own; the `activate` prune keeps exactly this name. */
export const OCR_ASSET_CACHE = `gubbins-ocr-assets-${OCR_ASSET_GENERATION}`;

/**
 * Where the staged assets live, relative to the app's base path — the single definition both the
 * engine (which builds the URLs it hands Tesseract) and the worker (which decides what to cache)
 * resolve against. Two independent spellings of this would diverge silently: the engine would fetch
 * from a directory the worker no longer recognises, and OCR would quietly stop working offline
 * again with every test still green.
 */
export const OCR_ASSET_DIR = 'ocr/';

/** The absolute root the OCR assets are served from, for an app served at `base`. */
export function ocrAssetRoot(base: string): string {
  return `${base.replace(/\/?$/, '/')}${OCR_ASSET_DIR}`;
}

/**
 * True when `url` addresses one of the staged OCR assets — same-origin, and under
 * {@link OCR_ASSET_DIR} beside the app itself. `scope` is any URL within the app's deployment (the
 * worker's own location), so the match tracks the `/Gubbins/` base path without the worker needing
 * the build constant. Kept pure so the routing decision is unit-testable without a worker global.
 */
export function isOcrAssetUrl(url: URL, scope: string | URL): boolean {
  const root = new URL(OCR_ASSET_DIR, scope);
  return url.origin === root.origin && url.pathname.startsWith(root.pathname);
}
