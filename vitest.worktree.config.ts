/**
 * Vitest config for running the app suite from **inside** a `.claude/worktrees/<name>` git
 * worktree.
 *
 * The main config excludes the `.claude/worktrees` glob so this checkout never sweeps a sibling
 * worktree's duplicate copy of `src/` (see `vite.config.ts`). Run the suite from *within* a
 * worktree, though, and that glob matches the worktree's own absolute path — every test file
 * is excluded and the run collects nothing, reporting a confusing "no tests found" rather
 * than an error.
 *
 * This config is the real one with only that single exclusion dropped. It deliberately
 * *extends* rather than restates: a hand-written minimal config has to re-declare the
 * `define` block (or anything importing `lib/app-version.ts` throws `__APP_VERSION__ is not
 * defined`) and still can't resolve `virtual:pwa-register` without the PWA plugin, so a
 * handful of files fail as pure config artefacts. Inheriting the plugin list and `define`
 * means a worktree run covers exactly what the primary checkout's run covers.
 *
 *   npx vitest run --config vitest.worktree.config.ts [files…]
 *
 * Do **not** junction `node_modules` into the worktree to make this work — the worktree lives
 * inside the repo, so Node's upward resolution already finds the real `node_modules`. A
 * junction gives the Vitest CLI and Vite two different realpaths for the same package, loading
 * two Vitest instances ("failed to find the current suite").
 */
import { defineConfig, configDefaults, type ViteUserConfig } from 'vitest/config';
import baseConfig from './vite.config';

const base = baseConfig as ViteUserConfig;

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // The `bridge/**` exclusion stays — it ships its own Node-environment config and is run
    // as a separate job. Only the worktrees glob goes.
    exclude: [...configDefaults.exclude, 'bridge/**'],
  },
});
