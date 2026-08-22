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
import { DEFAULT_BASE_PATH } from '../../base-path';

/** One origin the app is served from: a fixed scheme and host, on any port. */
interface AppOrigin {
  /** The exact scheme — GitHub Pages is https-only; a local dev server is http. */
  readonly scheme: 'http' | 'https';
  /** The exact host. Never a wildcard: `*.github.io` is every stranger's site too. */
  readonly host: string;
}

/**
 * The origins a Gubbins deployment is served from, matching the shipped build.
 *
 * `bootblock.github.io` is the hosted deployment (spec §1.2); `localhost`/`127.0.0.1` are a
 * developer's own dev server. Chrome match patterns cannot pin a port, so the two local
 * entries are narrowed by *path* instead — see {@link GUBBINS_APP_URL_PATTERNS}. A
 * self-hosted deployment on another origin (or another base path) is deliberately not
 * covered: the extension is optional, and a wildcard that admitted one self-hoster would
 * admit every unrelated site on the same host. See `extension/README.md` for the one-line
 * manifest edit a self-hoster makes to add their own origin.
 */
export const GUBBINS_APP_ORIGINS: readonly AppOrigin[] = [
  { scheme: 'https', host: 'bootblock.github.io' },
  { scheme: 'http', host: 'localhost' },
  { scheme: 'http', host: '127.0.0.1' },
];

/**
 * The Chrome match patterns for those origins, path-scoped to the app's base path.
 *
 * The path component is what does the real narrowing on `localhost`, where the port cannot be
 * expressed: an unrelated dev server on `http://localhost:3000/` is no longer injected into,
 * while `http://localhost:5173/Gubbins/` still is. Used verbatim for the manifest's
 * `content_scripts.matches` and for the worker's `chrome.tabs.query` delivery filter.
 */
export const GUBBINS_APP_URL_PATTERNS: readonly string[] = GUBBINS_APP_ORIGINS.map(
  ({ scheme, host }) => `${scheme}://${host}${DEFAULT_BASE_PATH}*`,
);

/**
 * Is this URL a page of the Gubbins PWA — the same set the manifest injects into?
 *
 * Kept deliberately strict, and in step with {@link GUBBINS_APP_URL_PATTERNS}: the scheme and
 * host must match an entry exactly (no subdomain, no look-alike suffix), and the path must sit
 * under the app's base path. Any port is accepted, because the match patterns cannot pin one
 * and the dev server's port varies.
 *
 * Used as defence-in-depth *inside* the code the manifest injects and the worker runs, so a
 * future widening of the patterns cannot silently re-open issue #493: the content script
 * refuses to install itself anywhere else, and the worker refuses to serve or deliver to
 * anything else.
 */
export function isGubbinsAppUrl(raw: string | undefined | null): boolean {
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
  const matches = GUBBINS_APP_ORIGINS.some(
    (origin) => origin.scheme === scheme && origin.host === url.hostname.toLowerCase(),
  );
  return matches && url.pathname.startsWith(DEFAULT_BASE_PATH);
}
