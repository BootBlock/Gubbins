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
 *
 * ## The one origin the user supplies (issue #385)
 *
 * Everything above is fixed at build time. One thing cannot be: the **bridge**, which lives
 * at an address only the user knows (`http://127.0.0.1:8787`, a NAS on the LAN, …). Push-to-
 * bridge and the scale reading fetch it directly, so it must appear in `connect-src` or the
 * browser blocks the request before it leaves the page — indistinguishable, from JavaScript,
 * from the bridge being offline.
 *
 * A browser enforces the **intersection** of every delivered policy, so it is not enough for
 * the service worker to compute a per-user header: the static `<meta>` would still veto it.
 * The fix is therefore for the worker to compute **both** forms — it already serves the app
 * shell, so it rewrites that shell's `<meta>` ({@link withCspMeta}) with the same policy it
 * puts on the header. The origin reaches the worker from the user's own preference (see
 * `lib/bridge-connect-policy.ts`); {@link toCspOrigin} is the single choke point that
 * validates it, so nothing that isn't a bare `http(s)` origin can ever reach a policy string.
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
  // Drive REST endpoint for the optional cloud-sync provider. The Open Food Facts origin is the
  // open, key-less product database an opt-in barcode lookup queries directly when the companion
  // extension isn't present (issue #59) — reached only after the user consents, never on load.
  // The OAuth consent step is a top-level navigation, not a fetch, so it needs no allowance here.
  ['connect-src', "'self' https://www.googleapis.com https://world.openfoodfacts.org"],
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
 * Reduce a user-entered URL to the bare `scheme://host[:port]` a CSP host-source may carry,
 * or `null` if it is not one — the **only** way a runtime value enters a policy string.
 *
 * The value originates in a text field and crosses a `postMessage` boundary before it is
 * spliced into a policy, so anything that could terminate a source list (`;`, whitespace, a
 * comma) would let a caller *rewrite* the policy rather than extend it. `URL.origin` already
 * normalises away paths, queries, fragments and credentials; the explicit character check
 * behind it is deliberate belt-and-braces on the one string in this file that isn't a literal.
 *
 * Only `http:` and `https:` are accepted — the same two `lib/bridge-url.ts` accepts from the
 * user — and an opaque origin (`file:`, `data:`, a blob) serialises to `"null"`, which is a
 * valid-looking but meaningless source.
 */
export function toCspOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // `[A-Za-z0-9.\-:[\]]` covers hostnames, IPv4, a port, and the bracketed IPv6 form — and
  // admits no character that could end a directive or start another one.
  return /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(parsed.origin) ? parsed.origin : null;
}

/**
 * Serialise the policy to a header/`<meta>` string. Pass `forMeta: true` to drop the
 * directives a `<meta>` cannot carry (so the meta form stays warning-free), and
 * `bridgeOrigin` to extend `connect-src` by the user's own bridge origin (issue #385).
 *
 * `bridgeOrigin` is re-validated here rather than trusted from the caller, so every path that
 * produces a policy — worker header, worker-rewritten meta, build-time meta — goes through the
 * same check.
 */
export function buildContentSecurityPolicy({
  forMeta = false,
  bridgeOrigin = null,
}: { forMeta?: boolean; bridgeOrigin?: string | null } = {}): string {
  const extra = bridgeOrigin === null ? null : toCspOrigin(bridgeOrigin);
  return CSP_DIRECTIVES.filter(([name]) => !(forMeta && META_UNSUPPORTED_DIRECTIVES.has(name)))
    .map(([name, value]) =>
      name === 'connect-src' && extra !== null ? `${name} ${value} ${extra}` : `${name} ${value}`,
    )
    .join('; ');
}

/** Matches the injected CSP `<meta>` whatever its attribute order or quoting style. */
const CSP_META_TAG = /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;

/**
 * Replace the CSP `<meta>` in an app-shell document with one carrying `policy`.
 *
 * The service worker serves `index.html` from its precache, so this is where the *delivered*
 * meta form is decided — the build-time tag Vite injects is only ever the starting point (and
 * the whole policy on a first load, before any worker is in control). HTML with no such tag —
 * a dev-server response, a non-shell document — is returned untouched.
 *
 * A policy string can only reach here from {@link buildContentSecurityPolicy}, which emits no
 * `"` and no `<`, so it needs no attribute escaping.
 */
export function withCspMeta(html: string, policy: string): string {
  return html.replace(CSP_META_TAG, `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

/**
 * Would a document enforcing `policy` be allowed to `fetch` `origin`?
 *
 * A **hint, not a security control** — the browser is the enforcer, and this only decides
 * whether the app offers "reload to connect to this bridge" instead of letting the call fail
 * as a phantom outage. It is deliberately conservative about what it recognises (an exact
 * origin, a scheme-source, `*`, and `'self'` when the bridge shares the app's origin), because
 * a false "allowed" merely restores today's misleading failure, while a false "blocked" would
 * nag about a reload that changes nothing.
 *
 * `policy` is `null` when no policy is delivered at all — the dev server — which blocks
 * nothing.
 */
export function policyAllowsConnectOrigin(
  policy: string | null,
  origin: string,
  selfOrigin: string | null = null,
): boolean {
  if (policy === null || policy.trim() === '') return true;
  // Absent `connect-src` falls back to `default-src`; absent both, the directive is unset and
  // the fetch is unrestricted.
  const sources = readDirectiveSources(policy, 'connect-src') ?? readDirectiveSources(policy, 'default-src');
  if (sources === null) return true;

  const wanted = origin.toLowerCase();
  const scheme = `${wanted.slice(0, wanted.indexOf(':'))}:`;
  return sources.some(
    (source) =>
      source === '*' ||
      source === scheme ||
      source === wanted ||
      (source === "'self'" && selfOrigin !== null && selfOrigin.toLowerCase() === wanted),
  );
}

/** The lower-cased source list of one directive, or `null` when the policy does not set it. */
function readDirectiveSources(policy: string, directive: string): string[] | null {
  for (const segment of policy.split(';')) {
    const [name, ...sources] = segment.trim().split(/\s+/).filter(Boolean);
    if (name !== undefined && name.toLowerCase() === directive) {
      return sources.map((source) => source.toLowerCase());
    }
  }
  return null;
}
