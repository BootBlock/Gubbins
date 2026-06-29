/**
 * Browser-only Google OAuth 2.0 for Drive sync (spec §1.2 "no cloud SDK", §7, Phase 7).
 *
 * Gubbins is a static, backend-less PWA (GitHub Pages), so it uses the OAuth 2.0
 * **implicit flow** via a top-level redirect: the app navigates to Google's consent
 * screen and Google redirects back with a short-lived access token in the URL *fragment*
 * (fragments never reach a server — the token stays on the device). There is no client
 * secret and no token exchange, so no backend is required and no Google JS SDK is loaded
 * (only `connect-src https://www.googleapis.com` is added to the CSP for the Drive REST
 * calls — the auth redirect is a navigation, not a fetch).
 *
 * The parsing/validation is pure and unit-tested; the redirect + storage glue is thin.
 * Because the app uses a hash router, {@link completeGoogleAuthRedirect} runs once at app
 * entry (before React mounts) to lift any auth fragment out of the URL so the router never
 * sees it.
 *
 * Limitation (documented in docs/dev/google-drive-sync.md): the implicit flow issues no
 * refresh token, so the ~1-hour access token is re-obtained with a fresh consent redirect
 * when it expires. The token is stored device-local in `localStorage` (mirroring the
 * existing bridge-token handling) and is never synced.
 */
import {
  GOOGLE_AUTH_ENDPOINT,
  googleDriveConfig,
  type GoogleDriveConfig,
} from './google-config';

/** A short-lived Google access token with its absolute expiry (epoch ms). */
export interface GoogleToken {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly scope?: string;
}

export type GoogleAuthResult =
  | { readonly ok: true; readonly token: GoogleToken; readonly state: string | null }
  | { readonly ok: false; readonly error: string; readonly state: string | null };

const TOKEN_KEY = 'gubbins:google-drive-token';
const PENDING_STATE_KEY = 'gubbins:google-oauth-pending';
const ERROR_KEY = 'gubbins:google-oauth-error';

/** Re-obtain the token this many ms *before* its stated expiry, to avoid mid-sync 401s. */
const EXPIRY_SKEW_MS = 60_000;

// --- pure: URL building, fragment parsing, validity ------------------------------

/** Build the Google consent URL for the implicit (access-token) flow. */
export function buildGoogleAuthUrl(config: GoogleDriveConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'token',
    scope: config.scope,
    state,
    include_granted_scopes: 'true',
    // Force the account chooser so a user with multiple Google accounts can pick.
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** Normalise a possibly-`#`-prefixed fragment to its raw `key=value&…` body. */
function fragmentBody(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

/**
 * Whether a location hash is an OAuth response fragment (a token grant or an error),
 * as opposed to an ordinary hash-router route like `#/inventory`. The token/error
 * markers must be top-level fragment params, so a route that merely *contains* the text
 * (e.g. `#/sync?q=access_token`) is correctly ignored.
 */
export function isGoogleAuthFragment(hash: string): boolean {
  const body = fragmentBody(hash);
  if (body.length === 0 || body.startsWith('/')) return false;
  const params = new URLSearchParams(body);
  return params.has('access_token') || params.has('error');
}

/**
 * Parse an OAuth redirect fragment into a {@link GoogleAuthResult}, or `null` when the
 * fragment is not an OAuth response at all. A token with no/garbled `expires_in` is given
 * an already-past expiry, so a malformed grant can never be trusted as live.
 */
export function parseGoogleAuthFragment(hash: string, now: number): GoogleAuthResult | null {
  if (!isGoogleAuthFragment(hash)) return null;
  const params = new URLSearchParams(fragmentBody(hash));
  const state = params.get('state');

  const error = params.get('error');
  if (error) return { ok: false, error, state };

  const accessToken = params.get('access_token');
  if (!accessToken) return { ok: false, error: 'invalid_response', state };

  const expiresIn = Number(params.get('expires_in'));
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now - 1;
  const scope = params.get('scope') ?? undefined;
  return { ok: true, token: { accessToken, expiresAt, scope }, state };
}

/** Whether a token is present and still live (accounting for the safety skew). */
export function tokenValid(
  token: GoogleToken | null | undefined,
  now: number,
  skewMs = EXPIRY_SKEW_MS,
): boolean {
  return !!token && token.accessToken.length > 0 && token.expiresAt - skewMs > now;
}

// --- thin glue: storage + the redirect handshake ---------------------------------

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // access can throw in locked-down/Private-mode contexts
  }
}

/** Load the device-local stored token, or `null` when absent/unparseable. */
export function loadGoogleToken(): GoogleToken | null {
  const store = safeLocalStorage();
  const raw = store?.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleToken>;
    if (typeof parsed.accessToken === 'string' && typeof parsed.expiresAt === 'number') {
      return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt, scope: parsed.scope };
    }
  } catch {
    // fall through
  }
  return null;
}

export function storeGoogleToken(token: GoogleToken): void {
  safeLocalStorage()?.setItem(TOKEN_KEY, JSON.stringify(token));
}

export function clearGoogleToken(): void {
  safeLocalStorage()?.removeItem(TOKEN_KEY);
}

/**
 * Begin the consent redirect (must be called from a user gesture). Stashes a random CSRF
 * `state` in `sessionStorage`, then navigates the whole tab to Google. The page is left
 * behind here; control resumes via {@link completeGoogleAuthRedirect} after Google returns.
 */
export function beginGoogleAuth(config: GoogleDriveConfig = googleDriveConfig()): void {
  if (typeof location === 'undefined') return;
  const state = crypto.randomUUID();
  try {
    sessionStorage.setItem(PENDING_STATE_KEY, state);
  } catch {
    // sessionStorage unavailable — proceed; the state check below will simply fail safe.
  }
  location.assign(buildGoogleAuthUrl(config, state));
}

export type RedirectOutcome = 'connected' | 'error' | 'none';

/**
 * Complete an in-progress auth redirect, if this load is one. Runs once at app entry,
 * *before* the hash router mounts, so the OAuth fragment is stripped from the URL and the
 * router never tries to route it. On success the token is stored and the URL is rewritten
 * to the Sync screen. A CSRF-`state` mismatch is treated as an error (the grant is dropped).
 */
export function completeGoogleAuthRedirect(now: number = Date.now()): RedirectOutcome {
  if (typeof location === 'undefined') return 'none';
  const result = parseGoogleAuthFragment(location.hash, now);
  if (!result) return 'none';

  let pending: string | null = null;
  try {
    pending = sessionStorage.getItem(PENDING_STATE_KEY);
    sessionStorage.removeItem(PENDING_STATE_KEY);
  } catch {
    // ignore
  }

  // Always lift the OAuth fragment out of the URL (and hand the user to the Sync screen),
  // whether or not it validated, so a refresh can't re-trigger it and the router stays clean.
  rewriteToSync();

  if (!result.ok) {
    rememberAuthError(result.error);
    return 'error';
  }
  if (!pending || pending !== result.state) {
    rememberAuthError('state_mismatch');
    return 'error';
  }
  storeGoogleToken(result.token);
  return 'connected';
}

function rewriteToSync(): void {
  try {
    const clean = `${location.pathname}${location.search}#/sync`;
    history.replaceState(null, '', clean);
  } catch {
    // history unavailable — last resort: blank the hash so the router doesn't choke.
    try {
      location.hash = '#/sync';
    } catch {
      /* give up silently */
    }
  }
}

function rememberAuthError(error: string): void {
  try {
    sessionStorage.setItem(ERROR_KEY, error);
  } catch {
    /* ignore */
  }
}

/** Read-and-clear any auth error recorded during {@link completeGoogleAuthRedirect}. */
export function consumeGoogleAuthError(): string | null {
  try {
    const err = sessionStorage.getItem(ERROR_KEY);
    if (err) sessionStorage.removeItem(ERROR_KEY);
    return err;
  } catch {
    return null;
  }
}
