/**
 * Builds the companion browser extension (spec §9, Phase 8).
 *
 * The only new build target this phase. It bundles the two entry points with Vite
 * (the project's rolldown-based bundler) reusing the **shared, unit-tested** protocol
 * and Strategy-parser modules from `src/features/scraping/` — so the wire contract and
 * the DOM-drift handling are identical to the PWA's and covered by the unit suite.
 *
 *  - `content-script.js` — classic IIFE (MV3 content scripts cannot be ES modules).
 *  - `background.js`      — ES module service worker.
 *
 * Output: `extension/dist/` (git-ignored). Load it unpacked via chrome://extensions.
 */
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, 'dist');

/** @param {string} entry @param {string} name @param {'es'|'iife'} format */
async function bundle(entry, name, format) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: resolve(root, entry),
        formats: [format],
        name: 'GubbinsExt',
        fileName: () => `${name}.js`,
      },
    },
  });
}

mkdirSync(outDir, { recursive: true });
await bundle('src/background.ts', 'background', 'es');
await bundle('src/content-script.ts', 'content-script', 'iife');
copyFileSync(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'));
console.log('✓ Gubbins extension built to', outDir);
