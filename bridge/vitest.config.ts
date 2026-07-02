import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Isolated Vitest config for the bridge package.
 *
 * Reuses the repo-root Vitest install (the bridge has no node_modules of its own) but
 * runs in a plain `node` environment — the bridge never touches the DOM. The single
 * `@/` alias points at the app's real `src/`, the same shared-code seam the runtime
 * loader honours, so tests exercise the app's actual search/DB modules unforked.
 *
 * `pool: 'threads'` mirrors the app config: on Node 25 the default `forks` pool hits a
 * cold-start race, and the `node:sqlite` driver runs correctly under worker_threads.
 */
export default defineConfig({
  // Pin the project root to this directory so test discovery and the include glob
  // stay inside the bridge, regardless of the cwd Vitest is launched from.
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'threads',
  },
});
