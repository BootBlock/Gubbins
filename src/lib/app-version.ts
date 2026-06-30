// `__APP_VERSION__` / `__APP_RELEASE_DATE__` are replaced at build time by Vite's
// `define`, both single-sourced from package.json (`version` and `releaseDate`) in
// vite.config.ts — so the UI never drifts from the real package version, the release
// date is pinned per version (bump both together), and package.json never enters the
// app bundle.
declare const __APP_VERSION__: string;
declare const __APP_RELEASE_DATE__: string;

/** The application version, single-sourced from package.json. */
export const APP_VERSION: string = __APP_VERSION__;

/** The release date (pinned per version in package.json) as an ISO `YYYY-MM-DD` string. */
export const APP_RELEASE_DATE: string = __APP_RELEASE_DATE__;
