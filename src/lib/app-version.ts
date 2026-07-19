// `__APP_VERSION__` / `__APP_RELEASE_DATE__` / `__APP_SCHEMA_VERSION__` are replaced at
// build time by Vite's `define`, all single-sourced from package.json (`version`,
// `releaseDate` and `schemaVersion`) in vite.config.ts — so the UI never drifts from the
// real package version, the release date is pinned per version (bump both together), and
// package.json never enters the app bundle.
declare const __APP_VERSION__: string;
declare const __APP_RELEASE_DATE__: string;
declare const __APP_SCHEMA_VERSION__: number;

/** The application version, single-sourced from package.json. */
export const APP_VERSION: string = __APP_VERSION__;

/** The release date (pinned per version in package.json) as an ISO `YYYY-MM-DD` string. */
export const APP_RELEASE_DATE: string = __APP_RELEASE_DATE__;

/**
 * The local-database compatibility generation, single-sourced from package.json
 * (`schemaVersion`). Bump it whenever a change alters how data is stored, so a peer that speaks
 * this generation (the bridge — see `features/sync/bridge-version.ts`) can tell it is talking to
 * a build it no longer matches.
 *
 * **It does not decide the update banner's data-safety promise** — that reads the *derived*
 * `BASELINE_REVISION` fingerprint instead (issue #274). A hand-maintained counter fails in
 * precisely the case that promise exists to catch: schema changes are folded into the
 * `v1-initial` baseline, so the fingerprint moves on its own while the counter waits for someone
 * to remember. See `components/PwaUpdatePrompt.tsx`.
 */
export const APP_SCHEMA_VERSION: number = __APP_SCHEMA_VERSION__;
