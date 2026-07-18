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
 * extensionless imports. Node strips the types natively, but resolves neither of those, so
 * a small synchronous resolve hook maps `@/` onto `src/` and retries a bare specifier as
 * `.ts` / `/index.ts`. That keeps this script dependency-free rather than pulling in a TS
 * runner for a job the platform can otherwise already do.
 */
import { registerHooks } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = pathToFileURL(resolvePath(repoRoot, 'src')).href;

/** Resolve a TypeScript-style extensionless specifier to a real file URL, or null. */
function withTsExtension(url) {
  for (const candidate of [`${url}.ts`, `${url}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const aliased = specifier.startsWith('@/') ? `${srcRoot}/${specifier.slice(2)}` : specifier;

    // Only relative/absolute specifiers can be extensionless source files; leave bare
    // package names ('node:sqlite', 'vitest') to Node's normal resolution.
    const isPathLike = aliased.startsWith('.') || aliased.startsWith('file:');
    if (isPathLike) {
      const base = aliased.startsWith('file:')
        ? aliased
        : new URL(aliased, context.parentURL ?? import.meta.url).href;
      const resolved = withTsExtension(base);
      if (resolved) return nextResolve(resolved, context);
    }

    return nextResolve(aliased, context);
  },
});

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
