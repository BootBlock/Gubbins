/**
 * Zero-dependency ESM resolve hook — the runtime half of the bridge's shared-code
 * mechanism (see README.md → "Shared-code mechanism").
 *
 * The app's source uses two conventions that plain Node ESM cannot resolve on its
 * own, but Vite/Vitest (and the app's bundler-mode tsconfig) can:
 *
 *   1. the `@/…` path alias for `src/…`, and
 *   2. extensionless relative imports (`./snapshot`, `../rpc/driver`).
 *
 * This hook teaches Node both, so the bridge can import the app's PURE search/DB
 * modules directly — `parseASTtoSQL`, the migration engine, backup/snapshot — with
 * NO forking and NO build step. Node 23.6+ then strips the TypeScript types on the
 * fly, so `.ts` runs directly. There are no runtime dependencies.
 *
 * It only ever rewrites a specifier when Node's own resolution fails, so npm/builtin
 * specifiers (`zustand`, `node:sqlite`, …) pass straight through untouched.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** Absolute path to the app's `src/` (the `@/` alias target), with a trailing sep. */
const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

/** Extension/index candidates for the bundler-mode extensionless imports. */
const SUFFIXES = ['.ts', '.tsx', '.mts', '/index.ts', '/index.tsx', '.js', '/index.js'];

export async function resolve(specifier, context, nextResolve) {
  // Map the `@/…` alias to a concrete file URL under the app's src/.
  const spec = specifier.startsWith('@/')
    ? pathToFileURL(path.join(SRC_ROOT, specifier.slice(2))).href
    : specifier;

  try {
    return await nextResolve(spec, context);
  } catch (err) {
    // Bundler-mode extensionless import: retry with each known suffix. Only attempt
    // this for file/relative specifiers so we never shadow a genuine bare-package miss.
    const relativeOrFile =
      spec.startsWith('file:') || spec.startsWith('./') || spec.startsWith('../');
    if (relativeOrFile) {
      for (const suffix of SUFFIXES) {
        try {
          return await nextResolve(spec + suffix, context);
        } catch {
          // Try the next candidate.
        }
      }
    }
    throw err;
  }
}
