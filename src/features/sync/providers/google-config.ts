/**
 * Google Drive OAuth/Drive configuration (spec §1.2, §7, Phase 7 cloud sync).
 *
 * Centralises the public, build-time configuration for the browser-only Google Drive
 * provider. Per §1.2 there is **no cloud SDK** and per the public-repo rules there is
 * **no secret**: only the public OAuth client id (injected via the `VITE_GOOGLE_CLIENT_ID`
 * environment variable) and values derivable from the running location.
 *
 * The redirect URI is derived from the app's own origin + base path, so it works
 * identically on `localhost` and a GitHub Pages deployment — the developer just registers
 * the matching URI(s) in the Google Cloud Console (see docs/dev/google-drive-sync.md).
 */

/**
 * The least-privilege Drive scope: an app-private folder Gubbins cannot see *or* touch
 * any of the user's other Drive files through. The whole sync snapshot lives there.
 */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** Google's OAuth 2.0 authorization endpoint (a top-level navigation target, not a fetch). */
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleDriveConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
}

/** The configured public OAuth client id, trimmed (`''` when unset). */
export function googleClientId(): string {
  return (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
}

/** Whether Google Drive sync is configured for this build (a client id is present). */
export function isGoogleDriveConfigured(): boolean {
  return googleClientId().length > 0;
}

/**
 * The OAuth redirect URI for this deployment: the app's own base URL (origin + Vite
 * `BASE_URL`), e.g. `https://name.github.io/Gubbins/`. Must be registered verbatim in the
 * OAuth client's "Authorised redirect URIs". Returns `''` when there is no `location`
 * (non-browser/test contexts).
 */
export function googleRedirectUri(): string {
  if (typeof location === 'undefined') return '';
  const base = import.meta.env.BASE_URL || '/';
  return new URL(base, location.origin).href;
}

/** Resolve the live Drive config from the environment + location. */
export function googleDriveConfig(): GoogleDriveConfig {
  return {
    clientId: googleClientId(),
    redirectUri: googleRedirectUri(),
    scope: GOOGLE_DRIVE_SCOPE,
  };
}
