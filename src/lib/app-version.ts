// `__APP_VERSION__` / `__APP_RELEASE_DATE__` are replaced at build time by Vite's
// `define` (version sourced from package.json, release date from the build date in
// vite.config.ts), so the UI never drifts from the real package version and
// package.json never enters the app bundle.
declare const __APP_VERSION__: string;
declare const __APP_RELEASE_DATE__: string;

/** The application version, single-sourced from package.json. */
export const APP_VERSION: string = __APP_VERSION__;

/** The release (build) date as an ISO `YYYY-MM-DD` string. */
export const APP_RELEASE_DATE: string = __APP_RELEASE_DATE__;
