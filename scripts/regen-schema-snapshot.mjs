/**
 * Regenerate the golden schema-baseline fixture.
 *
 *   node scripts/regen-schema-snapshot.mjs
 *
 * `src/db/migrations/__fixtures__/schema-baseline.snapshot.json` is the byte-for-byte
 * contract that `v1-initial.test.ts` asserts against, so *any* deliberate edit to the
 * squashed `v1-initial` baseline must be followed by a run of this script. Gubbins folds
 * schema changes into that single baseline rather than appending forward migrations
 * (see the header of `v1-initial.ts`), which means the fixture is the only thing standing
 * between an intended change and an accidental one — and hand-editing 5.5k lines of JSON
 * is exactly how it silently drifts.
 *
 * Run the test suite afterwards: a diff you did not expect in the regenerated fixture is
 * the signal to look again at what the baseline edit actually did.
 *
 * ## Why the module hook
 *
 * The migration sources are TypeScript using the `@/` path alias and TypeScript's
 * extensionless imports, which plain Node resolves for neither — see `app-ts-hooks.mjs`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { registerAppTsHooks } from './app-ts-hooks.mjs';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

registerAppTsHooks();

const { createMemoryDriver } = await import('../src/test/drivers/memory-driver.ts');
const { runMigrations } = await import('../src/db/migrations/engine.ts');
const { migrations } = await import('../src/db/migrations/index.ts');
const { captureSchemaSnapshot } = await import('../src/db/migrations/__fixtures__/schema-snapshot.ts');

const driver = createMemoryDriver();
try {
  await runMigrations(driver, migrations);
  const snapshot = await captureSchemaSnapshot(driver);

  const target = resolvePath(repoRoot, 'src/db/migrations/__fixtures__/schema-baseline.snapshot.json');
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  console.log(
    `Wrote ${snapshot.objects.length} schema objects across ${Object.keys(snapshot.tables).length} tables ` +
      `(user_version ${snapshot.userVersion}) to\n  ${target}`,
  );
} finally {
  await driver.close();
}
