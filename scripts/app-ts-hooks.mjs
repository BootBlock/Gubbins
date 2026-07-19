/**
 * Teach plain Node how to `import()` the app's TypeScript sources — the shared half of the
 * build/tooling scripts that need to *evaluate* app code rather than bundle it.
 *
 * The migration sources are TypeScript using the `@/` path alias and TypeScript's
 * extensionless imports. Node strips the types natively, but resolves neither of those, so
 * a small synchronous resolve hook maps `@/` onto `src/` and retries a bare specifier as
 * `.ts` / `/index.ts`. That keeps the scripts dependency-free rather than pulling in a TS
 * runner for a job the platform can otherwise already do. (The bridge solves the same problem
 * for its own long-lived process in `bridge/loader.mjs`.)
 *
 * The hooks are process-wide, so only call this from a script that owns its process.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
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

/** Register the `@/` alias + extensionless-import resolve hooks for this process. */
export function registerAppTsHooks() {
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
}
