/**
 * Single source of truth for the app's Content-Security-Policy (spec §2.2.6 hardening).
 *
 * Two consumers enforce the *same* policy at two layers:
 *   - The **service worker** ({@link import('./sw').default sw.ts}) sets it as a response
 *     header on every production response — the primary, enforced policy, and the only one
 *     that can express header-only directives like `frame-ancestors`.
 *   - A **build-only `<meta http-equiv>`** injected into `index.html` (see `vite.config.ts`)
 *     covers the very first navigation, *before* the service worker has taken control — so
 *     there is no unprotected first-load window.
 *
 * Defining the directives here means the header and meta forms can never silently drift
 * apart. The policy carries **no `'unsafe-inline'` in `script-src`**: the app ships zero
 * inline scripts (the COOP bootstrap and the PWA registration are external `'self'`
 * scripts), so script execution is restricted to same-origin files plus the
 * `'wasm-unsafe-eval'` the SQLite WASM module needs to instantiate.
 */

/** The CSP directives, in emission order. */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [name: string, value: string]> = [
  ['default-src', "'self'"],
  // No 'unsafe-inline': there are no inline scripts. 'wasm-unsafe-eval' lets the SQLite
  // WASM module instantiate (spec §2.2.1a); 'self' covers the app bundle, the external
  // COOP bootstrap, and the PWA registration script.
  ['script-src', "'self' 'wasm-unsafe-eval'"],
  // Inline styles remain allowed: React/Tailwind set element style attributes, and inline
  // styles are not a script-execution vector. Tightening this is a separate, larger change.
  ['style-src', "'self' 'unsafe-inline'"],
  ['img-src', "'self' data: blob:"],
  ['font-src', "'self' data:"],
  ['worker-src', "'self' blob:"],
  // 'self' covers the local app + same-origin time source; the Google APIs origin is the
  // Drive REST endpoint for the optional cloud-sync provider. The OAuth consent step is a
  // top-level navigation, not a fetch, so it needs no allowance here.
  ['connect-src', "'self' https://www.googleapis.com"],
  ['manifest-src', "'self'"],
  ['object-src', "'none'"],
  ['base-uri', "'self'"],
  ['frame-ancestors', "'none'"],
];

/**
 * Directives a `<meta http-equiv>` CSP cannot express — the browser ignores them there
 * (and logs a console warning). They are emitted only in the response-header form.
 */
const META_UNSUPPORTED_DIRECTIVES: ReadonlySet<string> = new Set(['frame-ancestors']);

/**
 * Serialise the policy to a header/`<meta>` string. Pass `forMeta: true` to drop the
 * directives a `<meta>` cannot carry (so the meta form stays warning-free).
 */
export function buildContentSecurityPolicy({ forMeta = false } = {}): string {
  return CSP_DIRECTIVES.filter(([name]) => !(forMeta && META_UNSUPPORTED_DIRECTIVES.has(name)))
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}
