/**
 * Bundle-size reporter (informational only).
 *
 * Prints the built `dist/` precache total so a size change is *visible* in the
 * build log. There is deliberately **no budget** — Gubbins is native-first (§2.4.3)
 * but the precache size is not a gate: a useful feature is never blocked or warned
 * against on size grounds. This script only reports; it never warns and never fails.
 *
 *   node scripts/check-bundle-size.mjs
 *
 * Mirrors vite-plugin-pwa's precache globs (the assets actually cached for offline).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/** Extensions vite-plugin-pwa precaches (see `injectManifest.globPatterns` in vite.config.ts). */
const PRECACHE_EXTENSIONS = new Set(['js', 'css', 'html', 'wasm', 'woff2', 'svg', 'ico']);

/** Recursively sum the size of precache-eligible files under a directory. */
function sumPrecacheBytes(dir) {
  let total = 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = sumPrecacheBytes(full);
      total += nested.total;
      count += nested.count;
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (PRECACHE_EXTENSIONS.has(ext)) {
        total += statSync(full).size;
        count += 1;
      }
    }
  }
  return { total, count };
}

let result;
try {
  result = sumPrecacheBytes(DIST);
} catch {
  console.warn('[bundle-size] dist/ not found — run `npm run build` first. Skipping.');
  process.exit(0);
}

const kib = result.total / 1024;
console.log(`[bundle-size] ${kib.toFixed(2)} KiB across ${result.count} precache files (no budget — informational only).`);

// Informational only: never fail the build.
process.exit(0);
