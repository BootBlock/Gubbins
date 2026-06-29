/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Typed app-specific Vite environment variables (spec §1.2). Keeping these explicit
 * (rather than relying on Vite's permissive `[key: string]: any` index signature)
 * means a typo in an env-var name is a compile error, not a silent `undefined`.
 */
interface ImportMetaEnv {
  /**
   * Google OAuth 2.0 **public** client id for Drive cloud sync (e.g.
   * `1234-abc.apps.googleusercontent.com`). Optional: when unset the Google Drive
   * option is hidden. No client *secret* is ever used (browser-only flow) — see
   * `docs/dev/google-drive-sync.md`.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
