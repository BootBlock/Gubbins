// Stages the on-device OCR assets (feature-gap G2) into `public/ocr/`.
//
// Receipt/label OCR runs entirely on-device via Tesseract.js WASM — keyless, no cloud, no
// third-party CDN (the app's strict CSP forbids one). Tesseract needs three things served
// from our own origin: its Web Worker script, a WASM core, and an English language model.
// The worker + core ship inside the `tesseract.js` / `tesseract.js-core` npm packages, so
// they are *copied* from node_modules; the language model is not distributed on npm, so it
// is *downloaded* here (once) from the official tessdata repositories.
//
// The whole `public/ocr/` tree is **git-ignored** — several MB of binaries must never enter
// the public repo — and is **precache-excluded** (see `injectManifest.globIgnores` in
// vite.config.ts), so it never bloats the offline app-shell. The OCR feature is opt-in and
// lazily loaded; where these assets are absent the feature degrades gracefully rather than
// failing the build. This script is therefore **not** wired into `npm run build`: run it
// once (`npm run ocr:assets`) to enable OCR locally.
//
//   node scripts/setup-ocr-assets.mjs [--force]
//
// It never fails the caller: a failed model download prints a warning and exits 0, leaving
// any already-staged assets in place.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  statSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

const require = createRequire(import.meta.url);
const OUT_DIR = fileURLToPath(new URL('../public/ocr/', import.meta.url));
const force = process.argv.includes('--force');

/** Resolve a file inside an installed package by its `package.json` location. */
function pkgDir(name) {
  return dirname(require.resolve(`${name}/package.json`));
}

/** Copy `from` → `OUT_DIR/name` unless it already exists (or `--force`). */
function stage(from, name = basename(from)) {
  const to = resolve(OUT_DIR, name);
  mkdirSync(dirname(to), { recursive: true });
  if (!force && existsSync(to)) return false;
  copyFileSync(from, to);
  return true;
}

/**
 * Download `url` → `OUT_DIR/name` (streamed to a temp file, then renamed, so an aborted
 * download never leaves a truncated model behind). Skipped when the target already exists.
 * Returns false and leaves things untouched on any network error.
 */
async function download(url, name) {
  const to = resolve(OUT_DIR, name);
  if (!force && existsSync(to) && statSync(to).size > 0) {
    console.log(`[ocr] have ${name} (${(statSync(to).size / 1048576).toFixed(1)}MB)`);
    return true;
  }
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.download`;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error('empty response');
    writeFileSync(tmp, bytes);
    renameSync(tmp, to);
    console.log(`[ocr] downloaded ${name} (${(bytes.byteLength / 1048576).toFixed(1)}MB)`);
    return true;
  } catch (err) {
    console.warn(`[ocr] could not download ${name} from ${url}: ${err.message}`);
    return false;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1. The Tesseract Web Worker script.
  const tessDist = resolve(pkgDir('tesseract.js'), 'dist');
  stage(resolve(tessDist, 'worker.min.js'));

  // 2. The WASM core. We copy every variant Tesseract might auto-select for its SIMD/OEM
  //    combination (a `.js` loader + `.wasm.js` shim + `.wasm` binary each) so the engine
  //    never fetches a file we didn't stage. It's git-ignored + precache-excluded, so the
  //    extra megabytes cost the repo and the offline shell nothing.
  const coreDir = pkgDir('tesseract.js-core');
  for (const file of readdirSync(coreDir)) {
    if (/\.(wasm|wasm\.js|js)$/.test(file) && file.startsWith('tesseract-core')) {
      stage(resolve(coreDir, file));
    }
  }

  // 3. The English language models, one directory per accuracy tier (the user chooses at
  //    runtime; `fast` is the default). `tessdata_fast` is the small integer model; the
  //    higher-accuracy tier is `tessdata_best` (LSTM). Both are OEM-1 compatible. Served
  //    uncompressed, so the engine loads them with `gzip: false`.
  const models = [
    ['fast', 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata'],
    ['best', 'https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata'],
  ];
  let fastOk = true;
  for (const [tier, url] of models) {
    const ok = await download(url, `tessdata-${tier}/eng.traineddata`);
    if (tier === 'fast') fastOk = ok;
  }

  if (!fastOk) {
    console.warn(
      '[ocr] the default (fast) model is missing — on-device OCR will stay unavailable until ' +
        'this script can reach the tessdata repositories. Re-run `npm run ocr:assets` when online.',
    );
  } else {
    console.log('[ocr] OCR assets ready in public/ocr/.');
  }
}

// Never fail the caller — OCR is an optional, opt-in feature (mirrors check-bundle-size.mjs).
main().catch((err) => {
  console.warn(`[ocr] setup skipped: ${err.message}`);
  process.exit(0);
});
