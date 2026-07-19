/**
 * Print this source tree's `BASELINE_REVISION` — the fingerprint derived from the squashed
 * `v1-initial` baseline's SQL (see `src/db/migrations/migration.ts`).
 *
 *   node scripts/baseline-revision.mjs
 *
 * The build calls this (see `versionManifestPlugin` in vite.config.ts) so the deployed
 * `version.json` publishes the *same* value that boot enforces via `assertBaselineCurrent`.
 * That is the point: the fingerprint is derived from the statements themselves, so an
 * already-installed build can tell — before the user reloads — whether the incoming deploy
 * still builds the database it has on disk. A hand-maintained counter cannot, because it
 * fails in exactly the case it exists to catch (issue #274).
 *
 * It runs in its own process rather than being imported into the Vite config because
 * evaluating the app's TypeScript needs process-wide module hooks (see `app-ts-hooks.mjs`),
 * which a build config has no business installing.
 *
 * Exits 0 having written the fingerprint plus a newline to stdout; any failure to evaluate
 * the baseline throws, so the caller fails loudly rather than shipping a manifest without it.
 */
import { registerAppTsHooks } from './app-ts-hooks.mjs';

registerAppTsHooks();

const { BASELINE_REVISION } = await import('../src/db/migrations/v1-initial.ts');

process.stdout.write(`${BASELINE_REVISION}\n`);
