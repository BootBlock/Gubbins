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
 * (`schemaVersion`). While Gubbins is pre-release (before 1.0) the on-disk schema is not
 * migrated forward — a build whose stored-data shape changes cannot carry old data across
 * (see the boot "reset your data" screen). This integer is the signal for that: bump it in
 * package.json whenever a change alters how data is stored, so an already-installed build
 * can compare its own value against a newer deploy's and warn the user *before* they update
 * that reloading will reset their data (issue #74). Leave it unchanged for updates that don't
 * touch the schema — those keep the user's data intact.
 */
export const APP_SCHEMA_VERSION: number = __APP_SCHEMA_VERSION__;
