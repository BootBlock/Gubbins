/**
 * Startup guard for the bridge's real Node floor.
 *
 * The bridge has no build step: every entry point (`cli.mjs`, `serve.mjs`, `mcp.mjs`)
 * dynamically imports TypeScript and relies on Node stripping the types at load. On a Node
 * that can't do that, the import dies with a bare `SyntaxError` pointing at a type
 * annotation — which reads as a broken repository rather than an old runtime. This module
 * turns that into a sentence saying which Node is running and which is needed.
 *
 * It is deliberately plain `.mjs` with no imports: it has to run *before* the first `.ts`
 * import, on exactly the runtimes where type-stripping may not work at all.
 *
 * Two independent requirements set the floor (see README.md -> Requirements):
 *
 *   - **Type-stripping**, unflagged from **v22.18.0** and **v24.0.0** (it existed behind
 *     `--experimental-strip-types` from v22.6.0).
 *   - **`node:sqlite` with FTS5**, which Gubbins' schema requires. It landed in **v22.16.0**
 *     and **v24.0.0** and was never backported to the **v23.x** line, so no v23 build can
 *     hydrate a snapshot however new it is.
 *
 * The guard is a shade more permissive than `package.json`'s `engines`, and that is
 * intentional: `engines` states the floor at which the bridge is *self-sufficient*, whereas
 * the guard reads `process.features.typescript` and so lets v22.16/v22.17 through when the
 * user has supplied `--experimental-strip-types` themselves — the fallback the README
 * documents.
 */

/**
 * The `engines.node` range in `bridge/package.json`, mirrored here as the self-sufficient
 * floor the messages quote. A unit test asserts the two never drift apart.
 */
export const SUPPORTED_NODE_RANGE = '>=22.18.0 <23.0.0 || >=24.0.0';

/**
 * First Node on the v22 line whose `node:sqlite` has FTS5 (nodejs/node#57621).
 *
 * There is deliberately no matching constant for the type-stripping floor: that half is
 * decided from `process.features.typescript`, which reports what the running Node will
 * actually do rather than what its version number implies.
 */
const FTS5_V22 = { major: 22, minor: 16 };

/**
 * Parse a `process.version`-shaped string into its numeric parts.
 *
 * @param {string} version e.g. `'v22.18.0'`.
 * @returns {{ major: number, minor: number } | null} `null` if it isn't recognisable, in
 *   which case the caller lets the run proceed rather than blocking on a version it can't read.
 */
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(String(version ?? ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Decide whether this Node can run the bridge.
 *
 * Pure — everything it inspects is passed in — so the whole decision table is unit-testable
 * without spawning a Node of each vintage.
 *
 * @param {object} [env] Runtime facts to judge; defaults to the current process.
 * @param {string} [env.version] A `process.version` string.
 * @param {string | false | undefined} [env.typescript] `process.features.typescript` —
 *   `'strip'`/`'transform'` when Node will strip types, falsy when it will not. Absent on
 *   Node < 22.10, which the version rules already reject.
 * @returns {string | null} A ready-to-print explanation, or `null` when the runtime is fine.
 */
export function checkNodeVersion({
  version = process.version,
  typescript = process.features.typescript,
} = {}) {
  const parsed = parseVersion(version);
  if (!parsed) return null;

  const { major, minor } = parsed;
  const running = `Running Node ${version}; the bridge needs ${SUPPORTED_NODE_RANGE}.`;

  // The v23 line never got FTS5, so it fails on the very first snapshot regardless of how
  // well it strips types. Call that out specifically — "upgrade to 23.6" is the plausible
  // wrong move otherwise.
  if (major === 23) {
    return [
      `The Gubbins bridge does not support any Node v23.x build. ${running}`,
      '',
      "Node's `node:sqlite` only gained FTS5 support in v22.16.0 and v24.0.0, and it was never",
      "backported to the v23.x line — so a v23 Node fails to build Gubbins' search index",
      '(`no such module: fts5`) even though it runs the TypeScript fine.',
      '',
      'Install Node 24 (or newer), or the 22.18+ LTS line.',
    ].join('\n');
  }

  if (major < FTS5_V22.major || (major === FTS5_V22.major && minor < FTS5_V22.minor)) {
    return [
      `This Node is too old to run the Gubbins bridge. ${running}`,
      '',
      'It needs two things this build lacks: built-in TypeScript type-stripping (the bridge has',
      "no build step) and `node:sqlite` with FTS5 support (Gubbins' search index).",
      '',
      'Install Node 24 (or newer), or the 22.18+ LTS line.',
    ].join('\n');
  }

  // v22.16/v22.17 have FTS5 but only strip types behind a flag; anything above strips by
  // default. Either way, trust what Node reports rather than re-deriving it from the number.
  if (!typescript) {
    return [
      `This Node cannot strip TypeScript types, which the Gubbins bridge needs. ${running}`,
      '',
      "The bridge has no build step — it imports the app's `.ts` directly and relies on Node",
      'erasing the types at load. That is only unflagged from v22.18.0 and v24.0.0.',
      '',
      'Install Node 24 (or newer) or the 22.18+ LTS line — or re-run this command with',
      '`node --experimental-strip-types …` on the Node you have.',
    ].join('\n');
  }

  return null;
}

/**
 * Print the verdict and stop the process when this Node can't run the bridge.
 *
 * Called at the top of every `.mjs` entry point, before the first `.ts` import.
 */
export function assertSupportedNodeVersion() {
  const problem = checkNodeVersion();
  if (!problem) return;
  console.error(`${problem}\n\nSee bridge/README.md -> Requirements.`);
  process.exit(1);
}
