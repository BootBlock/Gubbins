/**
 * Vite dev-server config for running the app from **inside** a `.claude/worktrees/<name>` git
 * worktree.
 *
 * A worktree has no `node_modules` of its own, so `@sqlite.org/sqlite-wasm` resolves up to the
 * primary checkout's copy — outside the worktree's `server.fs.allow` root. Vite then serves the
 * loader via an `@fs/…` URL while the sibling `.wasm` binary 404s, the database never
 * initialises, and the app hangs before it ever reaches "Add item". Junctioning `node_modules`
 * into the worktree is not enough on its own: Vite dereferences the link and goes back to the
 * `@fs` path.
 *
 * `resolve.preserveSymlinks` is what fixes it — the junction is then treated as a real in-root
 * directory, so the `.wasm` is served as an ordinary asset. It lives here rather than in
 * `vite.config.ts` because it is purely a worktree workaround: turning it on for the primary
 * checkout would change module resolution (and therefore dependency de-duplication) for every
 * ordinary dev run and build.
 *
 *   # from the worktree root, with node_modules junctioned in:
 *   npx vite --config vite.worktree.config.ts --port 5199
 *
 * Remove the junction again **before** running Vitest (two realpaths for the same package loads
 * two Vitest instances) and before `git worktree remove`. See `.claude/skills/verify/SKILL.md`.
 */
import { defineConfig, type UserConfig } from 'vite';
import baseConfig from './vite.config';

const base = baseConfig as UserConfig;

export default defineConfig({
  ...base,
  resolve: { ...base.resolve, preserveSymlinks: true },
});
