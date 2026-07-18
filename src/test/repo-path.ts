/**
 * Resolves a path inside the checkout that a *test file itself* lives in.
 *
 * Guards that read repository files (the `docs/todo` status banner, the wiki table-link
 * escaping, the extension manifest, the COI bootstrap) used to resolve against
 * `process.cwd()`. That is wrong whenever cwd is not the checkout under test: a worktree's
 * suite can be run from the primary checkout, and a cwd-relative guard then reads the
 * *primary's* files and reports green while the worktree's edits go entirely unverified —
 * a passing run that proves nothing about the change it was meant to check.
 *
 * Two traps make this fiddlier than it looks, both verified empirically under this repo's
 * Vitest setup rather than assumed:
 *
 * 1. An **inline** `import.meta.url` used directly as a call argument is rewritten by Vite's
 *    transform to the module's `http:` self-URL, so `fileURLToPath` throws
 *    `ERR_INVALID_URL_SCHEME`. (The older comments in these guards blamed happy-dom for this
 *    and concluded a file-relative approach was impossible — the environment is not the
 *    cause.) Callers therefore pass `import.meta.dirname`, a plain string that no transform
 *    rewrites.
 * 2. Resolving to a path that does not exist would fail *silently* as an empty directory
 *    listing — the exact failure mode this helper exists to kill — so the resolved root is
 *    asserted to exist and throws loudly if it does not.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param testDirname the calling test file's own `import.meta.dirname`
 * @param segments    path segments below the repository root, e.g. `'docs', 'wiki'`.
 *                    Pass none to get the checkout root itself.
 */
export function repoPath(testDirname: string, ...segments: string[]): string {
  // Walk up from the test's own directory to the nearest `package.json` rather than assuming a
  // fixed depth, so this stays correct however deeply a test file is nested. There is no
  // `package.json` anywhere under `src/`, so the first one found is the checkout root.
  let dir = testDirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = join(dir, '..');
    if (parent === dir) {
      throw new Error(`repoPath: no package.json above ${testDirname} — cannot locate the checkout root`);
    }
    dir = parent;
  }

  const resolved = join(dir, ...segments);
  if (!existsSync(resolved)) {
    throw new Error(
      `repoPath: ${resolved} does not exist. The guard would otherwise inspect nothing and pass.`,
    );
  }
  return resolved;
}
