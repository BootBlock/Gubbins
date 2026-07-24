/**
 * Cross-origin (CORS) origin policy for the bridge HTTP server (issue #182).
 *
 * The bridge authenticates with a bearer token carried in the `Authorization` header (never a
 * cookie), so there is no ambient-authority CSRF and the token — not the browser's same-origin
 * policy — is the security boundary. But the bridge sits on the LAN, and a permissive
 * `Access-Control-Allow-Origin: *` let *any* web page the victim happened to be viewing script
 * requests at it from inside the network: a free scanning / token-brute-force position a remote
 * attacker could not otherwise route to. Stripping CORS only from error responses does not close
 * that — a correct token still yields a readable `200`, so success stays distinguishable — so the
 * bridge instead reflects an **allow-list** of origins and grants CORS to nothing else. An
 * unlisted browser origin then sees every response (success *and* error) as an opaque failure, so
 * it can no longer tell a good token from a bad one.
 *
 * This only affects **browsers** — CORS is a browser concept. A non-browser client (Home
 * Assistant, a Prometheus scrape, `curl`, the MCP server) sends no `Origin` header and is
 * unaffected: it never needed an `Access-Control-Allow-Origin` header to read the body.
 *
 * Pure and side-effect-free: parsing and the per-request decision are plain functions over their
 * inputs, so both are trivially testable with no server or socket.
 */

/**
 * The bridge's own hosted app origin — the GitHub-Pages deployment (`package.json` `homepage`).
 * The path (`/Gubbins/`) is not part of an origin, so only the scheme + host appear here. Included
 * in the default allow-list so the shipped app's "push to bridge" works out of the box.
 */
export const HOSTED_APP_ORIGIN = 'https://bootblock.github.io';

/**
 * The default allow-list when `GUBBINS_BRIDGE_ALLOWED_ORIGINS` is unset: just the hosted app
 * origin. Loopback origins (a dev server, a locally-served build) are *always* allowed on top of
 * this — see {@link isLoopbackOrigin} — so they are not listed here.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [HOSTED_APP_ORIGIN];

/**
 * A resolved origin policy: either the wildcard (grant CORS to every origin, the old permissive
 * behaviour, opt-in via `GUBBINS_BRIDGE_ALLOWED_ORIGINS=*`) or an exact-match allow-list. Loopback
 * origins are allowed in both cases (they can only be the user's own machine).
 */
export type AllowedOrigins =
  { readonly wildcard: true } | { readonly wildcard: false; readonly origins: ReadonlySet<string> };

/** The permissive wildcard policy — grant `Access-Control-Allow-Origin: *` to everyone. */
export const WILDCARD_ORIGINS: AllowedOrigins = { wildcard: true };

/**
 * Whether an `Origin` value is a loopback address — a page served from the user's own machine
 * (a dev server, or a locally-served build). These are always allowed: a remote attacker cannot
 * make a browser report a loopback `Origin`, and anything that *can* serve a page from loopback on
 * the victim's machine already has code execution, at which point CORS is moot. Only `http(s)` on
 * `localhost` / `127.0.0.1` / `::1` (any port) qualifies.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Parse `GUBBINS_BRIDGE_ALLOWED_ORIGINS` into a resolved {@link AllowedOrigins}.
 *
 * - **Unset / blank** → the {@link DEFAULT_ALLOWED_ORIGINS} allow-list (secure default).
 * - **`*`** (alone or among others) → the wildcard, restoring the old permissive behaviour for an
 *   operator who deliberately wants it.
 * - **A comma-separated list** → those exact origins. Each is normalised to its origin form
 *   (scheme + host + port; a trailing path is dropped), and a value that is not a valid `http(s)`
 *   origin throws a clear, secret-free error so a typo fails loudly at startup.
 */
export function parseAllowedOrigins(raw: string | undefined): AllowedOrigins {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return { wildcard: false, origins: new Set(DEFAULT_ALLOWED_ORIGINS) };
  }

  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.includes('*')) return WILDCARD_ORIGINS;
  if (entries.length === 0) {
    throw new Error(
      'GUBBINS_BRIDGE_ALLOWED_ORIGINS must list at least one origin (e.g. https://app.example.com) or "*".',
    );
  }

  const origins = new Set<string>();
  for (const entry of entries) {
    const normalised = normaliseOrigin(entry);
    if (normalised === null) {
      throw new Error(
        `GUBBINS_BRIDGE_ALLOWED_ORIGINS contains an invalid origin: "${entry}" ` +
          '(expected an absolute http(s) origin such as https://app.example.com, or "*").',
      );
    }
    origins.add(normalised);
  }
  return { wildcard: false, origins };
}

/** Normalise an operator-supplied entry to its `http(s)` origin, or `null` when it is not one. */
function normaliseOrigin(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/**
 * Decide the `Access-Control-Allow-Origin` value for one request, or `null` to send no CORS header
 * at all. Wildcard mode always answers `*`. Otherwise a request carrying no `Origin` (a non-browser
 * client) needs no header, a loopback origin is reflected, an allow-listed origin is reflected, and
 * anything else is refused (`null`) — the browser then blocks the page from reading the response.
 */
export function corsAllowOrigin(originHeader: string | undefined, allowed: AllowedOrigins): string | null {
  if (allowed.wildcard) return '*';
  if (originHeader === undefined) return null;
  if (isLoopbackOrigin(originHeader)) return originHeader;
  return allowed.origins.has(originHeader) ? originHeader : null;
}
