/**
 * The bridge's version — derived from the app's, never hand-maintained (issue #282).
 *
 * ## Why there is no separate bridge version
 *
 * The bridge has **no build step and no published artefact** (by design: Node strips the
 * types and runs the TypeScript directly). It ships as source *inside this repository*, so
 * "which bridge am I running?" only ever has one truthful answer: **whichever commit of
 * Gubbins the checkout is on**. A second, independently hand-edited number in
 * `bridge/package.json` could only ever agree with that by accident — and it didn't: it sat
 * at `0.0.1` while the app moved on, so the version the bridge advertised over mDNS was a
 * constant that never changed.
 *
 * So the bridge deliberately has no version of its own. It reads the repository's, which is
 * the same number the PWA reports in its About screen. One number, structurally incapable of
 * drifting, and directly comparable against the app the user is running.
 *
 * ## Why a static import
 *
 * The root `package.json` is present in **both** supported deployments — a git checkout and
 * the Docker image (`bridge/Dockerfile` copies it in for exactly this reason). It is not
 * optional runtime configuration, so a missing file means a broken checkout rather than a
 * situation worth degrading gracefully for.
 */
import rootPackageJson from '../../package.json' with { type: 'json' };

/**
 * The Gubbins version this bridge is part of, e.g. `1.2.0`. Compare it against the PWA's
 * `APP_VERSION` to see whether a checkout has fallen behind the app it is serving.
 */
export const BRIDGE_VERSION: string = rootPackageJson.version;

/**
 * The database schema generation this bridge's shared app modules expect.
 *
 * This — not {@link BRIDGE_VERSION} — is the number that decides whether a bridge can read a
 * snapshot *correctly*. A version behind is untidy; a schema behind means the bridge may be
 * reading columns that have since moved, which is the "silently serving wrong data" failure
 * the version alone cannot catch.
 */
export const BRIDGE_SCHEMA_VERSION: number = rootPackageJson.schemaVersion;
