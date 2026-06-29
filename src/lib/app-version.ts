// `__APP_VERSION__` is replaced at build time by Vite's `define` (sourced from
// package.json in vite.config.ts), so the About screen never drifts from the
// real package version and package.json never enters the app bundle.
declare const __APP_VERSION__: string;

/** The application version, single-sourced from package.json. */
export const APP_VERSION: string = __APP_VERSION__;
