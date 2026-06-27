/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves Gubbins under a project sub-path (spec §1.2).
  base: '/Gubbins/',

  plugins: [
    // Must precede @vitejs/plugin-react so generated route modules are transformed.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest lets a single custom worker (src/sw.ts) handle BOTH
      // offline precaching (§2.4.5) and COOP/COEP header injection for static
      // hosts (§2.2.6) — avoiding the two-service-worker scope conflict a
      // standalone coi-serviceworker would cause.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      injectManifest: {
        // SQLite WASM binaries are large, so lift the default 2 MiB single-file cap.
        globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,ico}'],
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
        icons: [
          {
            src: 'icons/gubbins.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
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
  },
});
