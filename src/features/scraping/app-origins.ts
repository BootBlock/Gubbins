/**
 * Where the Gubbins PWA actually lives — the single source of truth for the *one* page the
 * companion extension talks to (§9.1 origin verification, issue #493).
 *
 * The extension used to inject its content script by host alone (`https://*.github.io/*`,
 * `http://localhost/*`) and then treat "whatever origin this page happens to be" as the
 * trusted one. Chrome match patterns ignore the port and `*.github.io` covers every GitHub
 * Pages site on the internet, so that made `trustedOrigins = [window.location.origin]` a
 * tautology: any page anyone publishes under `*.github.io` was injected into, could drive the
 * scraper by posting a message to itself, and received the active-tab payloads the worker
 * broadcasts. Narrowing the patterns is what makes the origin check mean something again — a
 * check can only be as good as the set of pages the checking code runs in.
 *
 * Everything that needs to know "is this the app?" derives from {@link GUBBINS_APP_ORIGINS}:
 * the manifest's `content_scripts.matches` (pinned by `app-origins.test.ts`), the background
 * worker's delivery targets and sender checks, and the content script's own self-check.
 *
 * Pure and dependency-free, so it is unit-tested here and bundled into the extension.
 */
import { DEFAULT_BASE_PATH, resolveBasePath } from '../../base-path';

/** One place the app is served from: a fixed scheme and host, a base path, and any port. */
export interface AppOrigin {
  /** The exact scheme — GitHub Pages is https-only; a local dev server is http. */
  readonly scheme: 'http' | 'https';
  /** The exact host. Never a wildcard: `*.github.io` is every stranger's site too. */
  readonly host: string;
  /**
   * The base path the app is served under — the same value Vite is built with
   * ({@link DEFAULT_BASE_PATH}, or a `GUBBINS_BASE_PATH` override). It is carried per origin
   * rather than globally because a self-hosted deployment usually serves the app at the domain
   * root (`'/'`) while the hosted one sits under `/Gubbins/`, and because the path is the only
   * narrowing a match pattern has on `localhost`, where it cannot pin a port.
   *
   * Normalised through {@link resolveBasePath} before it is used, so an entry written `/gubbins`
   * means the directory and not the prefix. Without that, `/gubbins` would admit
   * `/gubbins-evil/` — the very path-prefix hole this module exists to close, reopened by a
   * missing slash in a hand-written entry.
   */
  readonly path: string;
}

/**
 * The origins a Gubbins deployment is served from, matching the shipped build.
 *
 * `bootblock.github.io` is the hosted deployment (spec §1.2); `localhost`/`127.0.0.1` are a
 * developer's own dev server, both serving the app under {@link DEFAULT_BASE_PATH}.
 *
 * A self-hosted deployment is deliberately **not** covered by a wildcard: the extension is
 * optional, and a pattern broad enough to admit one self-hoster's address would admit every
 * unrelated site sharing it — which is issue #493 again. A self-hoster adds their own entry
 * here (scheme, host and the base path they built with), mirrors it into the manifest, and
 * rebuilds; `extension/README.md` carries the recipe. Editing the built manifest alone is not
 * enough, because {@link isGubbinsAppUrl} is compiled into the content script.
 */
export const GUBBINS_APP_ORIGINS: readonly AppOrigin[] = [
  { scheme: 'https', host: 'bootblock.github.io', path: DEFAULT_BASE_PATH },
  { scheme: 'http', host: 'localhost', path: DEFAULT_BASE_PATH },
  { scheme: 'http', host: '127.0.0.1', path: DEFAULT_BASE_PATH },
];

/**
 * The Chrome match patterns for those origins, each path-scoped to its own base path.
 *
 * The path component is what does the real narrowing on `localhost`, where the port cannot be
 * expressed: an unrelated dev server on `http://localhost:3000/` is no longer injected into,
 * while `http://localhost:5173/Gubbins/` still is. Used verbatim for the manifest's
 * `content_scripts.matches` and for the worker's `chrome.tabs.query` delivery filter.
 */
export const GUBBINS_APP_URL_PATTERNS: readonly string[] = GUBBINS_APP_ORIGINS.map((origin) => {
  const { scheme, host, path } = normaliseOrigin(origin);
  return `${scheme}://${host}${path}*`;
});

/**
 * An entry in the form both halves compare against: a lower-case host and a directory path.
 *
 * Chrome lower-cases a match pattern's host, and `URL` lower-cases a parsed one, so an entry
 * written `Gubbins.Example.com` would inject and then fail the predicate — an extension that is
 * loaded, injected and silently inert. Normalising once here keeps the pattern and the predicate
 * reading the same thing, whatever case or trailing slash the entry was written with.
 */
function normaliseOrigin(origin: AppOrigin): AppOrigin {
  return {
    scheme: origin.scheme,
    host: origin.host.trim().toLowerCase(),
    path: resolveBasePath(origin.path),
  };
}

/**
 * Is this URL a page of the Gubbins PWA — the same set the manifest injects into?
 *
 * Kept deliberately strict, and in step with {@link GUBBINS_APP_URL_PATTERNS}: the scheme and
 * host must match an entry exactly (no subdomain, no look-alike suffix), and the path must sit
 * under *that entry's* base path. Any port is accepted, because the match patterns cannot pin
 * one and the dev server's port varies.
 *
 * Used as defence-in-depth *inside* the code the manifest injects and the worker runs, so a
 * future widening of the patterns cannot silently re-open issue #493: the content script
 * refuses to install itself anywhere else, and the worker refuses to serve or deliver to
 * anything else.
 */
export function isGubbinsAppUrl(raw: string | undefined | null): boolean {
  return matchesAppOrigin(raw, GUBBINS_APP_ORIGINS);
}

/**
 * The rule {@link isGubbinsAppUrl} applies, against an arbitrary origin list.
 *
 * Split out so the rule can be exercised against an entry the shipped build does not carry — a
 * self-hoster's own origin, served at the domain root — without a test being able to widen the
 * list the extension actually runs on. Every caller in the extension uses `isGubbinsAppUrl`.
 */
export function matchesAppOrigin(raw: string | undefined | null, origins: readonly AppOrigin[]): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Credentials in the URL are the classic host disguise (`https://bootblock.github.io@evil.test/`),
  // and the real app never carries them.
  if (url.username !== '' || url.password !== '') return false;
  const scheme = url.protocol.replace(/:$/, '');
  const host = url.hostname.toLowerCase();
  return origins
    .map(normaliseOrigin)
    .some(
      (origin) => origin.scheme === scheme && origin.host === host && url.pathname.startsWith(origin.path),
    );
}
