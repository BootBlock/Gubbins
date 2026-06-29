/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';
import { buildContentSecurityPolicy } from './src/csp';

// Single-source the app version from package.json (read here so it never enters
// the TS program / app bundle as a JSON import) and expose it via `define`.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Cross-origin isolation headers (spec §2.2.6).
 *
 * The high-performance SQLite OPFS VFS coordinates synchronous blocking between
 * the worker and the file system via `SharedArrayBuffer`, which browsers only
 * expose to cross-origin-isolated contexts. We set these on the dev and preview
 * servers directly; production (GitHub Pages — spec §1.2) cannot set response
 * headers, so it relies on the `coi-serviceworker` polyfill loaded in index.html.
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

/**
 * Inject a `<meta http-equiv="Content-Security-Policy">` into `index.html` at **build
 * time only** (spec §2.2.6 hardening). The service worker sets the authoritative CSP as a
 * response header, but it is not in control of the very first navigation; this meta covers
 * that first-load window with the same policy (minus the directives a `<meta>` cannot
 * express). It is `apply: 'build'` so Vite's dev server — whose HMR needs inline scripts,
 * `eval`, and a `ws:` connection — is left completely untouched.
 */
function cspMetaPlugin(): Plugin {
  return {
    name: 'gubbins-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: buildContentSecurityPolicy({ forMeta: true }),
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

/**
 * Emit `404.html` as a copy of the built `index.html` so client-side deep links work on
 * GitHub Pages (spec §1.2). Pages returns `404.html` for any path that doesn't map to a
 * file; serving the app shell there lets the SPA router resolve the real route on a
 * first/cold load (before the service worker is in control). A byte-copy keeps the strict
 * CSP intact — the usual `404.html` redirect trick needs an inline script, which the
 * `script-src` policy (no `'unsafe-inline'`) forbids. Runs in `closeBundle`, after the
 * final (PWA- and CSP-meta-transformed) `index.html` has been written to disk.
 */
function spa404FallbackPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'gubbins-spa-404',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const index = resolve(outDir, 'index.html');
      if (existsSync(index)) copyFileSync(index, resolve(outDir, '404.html'));
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves Gubbins under a project sub-path (spec §1.2).
  base: '/Gubbins/',

  // Build-time constant consumed by src/lib/app-version.ts (About screen).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  build: {
    // Vite's modulepreload polyfill ships as an *inline* <script> in index.html, which would
    // force `script-src 'unsafe-inline'`. The app's browser baseline (OPFS, SharedArrayBuffer,
    // BarcodeDetector) already implies native modulepreload support, so disabling the polyfill
    // removes the only remaining inline script and lets the CSP drop 'unsafe-inline'.
    modulePreload: { polyfill: false },
  },

  plugins: [
    // Must precede @vitejs/plugin-react so generated route modules are transformed.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    cspMetaPlugin(),
    spa404FallbackPlugin(),
    VitePWA({
      // injectManifest lets a single custom worker (src/sw.ts) handle BOTH
      // offline precaching (§2.4.5) and COOP/COEP header injection for static
      // hosts (§2.2.6) — avoiding the two-service-worker scope conflict a
      // standalone coi-serviceworker would cause.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // `prompt` (not `autoUpdate`): a new build installs but stays *waiting* — it never
      // activates or reloads the page out from under the user. The app surfaces a
      // "Reload now" prompt (PwaUpdatePrompt) and only swaps to the new version when the
      // user opts in, so in-flight, unsaved work on the current page is never lost.
      registerType: 'prompt',
      // Registration happens in app code via the `virtual:pwa-register` module
      // (usePwaUpdate), which is part of the hashed app bundle — so the CSP can still
      // forbid inline script entirely (see src/csp.ts). Hence no injected snippet.
      injectRegister: null,
      injectManifest: {
        // SQLite WASM binaries are large, so lift the default 2 MiB single-file cap.
        // `png` is included so the raster app icons are precached for offline too.
        globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,ico,png}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        id: '/Gubbins/',
        name: 'Gubbins',
        short_name: 'Gubbins',
        description:
          'Local-first inventory tracking for electronics, 3D-printing supplies, tools, and general inventory.',
        lang: 'en-GB',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'any',
        scope: '/Gubbins/',
        start_url: '/Gubbins/',
        // A scalable vector master plus raster fallbacks. The `any` and `maskable`
        // purposes are kept on *separate* assets: the maskable PNG carries the safe-zone
        // padding Android's adaptive mask needs, so reusing one image for both (which
        // would crop the glyph) is avoided. PNGs also cover platforms — notably iOS,
        // see the apple-touch-icon in index.html — that ignore SVG manifest icons.
        // The icon set is generated from a single glyph by scripts/generate-icons.mjs.
        icons: [
          {
            src: 'icons/gubbins.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // The Service Worker stays out of the way during local development; OPFS
      // and COI are exercised via the dev-server headers instead.
      devOptions: { enabled: false },
    }),
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // @sqlite.org/sqlite-wasm ships its own worker + .wasm asset and must not be
  // pre-bundled/transformed by esbuild (official Vite guidance).
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },

  worker: {
    format: 'es',
  },

  server: {
    headers: { ...crossOriginIsolationHeaders },
  },
  preview: {
    headers: { ...crossOriginIsolationHeaders },
  },

  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // SQLite WASM / worker integration is validated via the :memory: driver and
    // mocked RPC bridge (spec §8.5), so no CSS or worker processing is needed here.
    css: false,
    // Use the worker_threads pool rather than Vitest's default `forks` pool.
    // On Node 25 the forks pool (tinypool spawning `child_process.fork` workers)
    // hits a cold-start race that crashes the whole run once on a cold cache —
    // every file reports "no tests" with `TypeError: Cannot read properties of
    // undefined (reading 'config')` after a ~33 s environment setup. The threads
    // pool runs in-process worker_threads, sidestepping that spawn race entirely;
    // it is stable across cold starts and markedly faster here (the `:memory:`
    // node:sqlite driver runs correctly under worker_threads). Per-file module
    // isolation (Vitest's default) is preserved, so no global state leaks.
    pool: 'threads',
    // The companion bridge (`bridge/`) ships its own Vitest config — a Node
    // environment and Node >= 23.6 for `node:sqlite` + type-stripping — and is run
    // as a separate CI job (`bridge/vitest.config.ts`). Exclude it here so the app
    // suite (happy-dom, Node 20) never sweeps the bridge's Node-only tests, which
    // would fail under the wrong environment.
    //
    // Also exclude `.claude/worktrees/**`: when a parallel agent has a sibling git
    // worktree checked out under that path, it carries a full copy of `src/` (and its
    // own `node_modules`). Vitest would otherwise discover those duplicate `*.test`
    // files — and, worse, a positional path filter like `src/features/...` matches the
    // worktree copy as a substring too — loading a second React/react-dom into the same
    // worker and breaking hooks for every test in the run. Keeping the sweep inside this
    // checkout makes the suite robust while other agents work in their own worktrees.
    exclude: [...configDefaults.exclude, 'bridge/**', '**/.claude/worktrees/**'],
  },
});
