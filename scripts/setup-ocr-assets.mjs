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
// A *published* build is different. Because the tree is git-ignored, a CI checkout has no
// `public/ocr/` at all, so a deploy that skipped this step would publish a documented,
// settings-exposed feature that can never work — and say nothing, since the same graceful
// degradation hides it. The deploy workflow therefore runs this script before
// `npm run build`, with `--require`.
//
//   node scripts/setup-ocr-assets.mjs [--force] [--require]
//
// By default it never fails the caller: a failed model download prints a warning and exits 0,
// leaving any already-staged assets in place. With `--require` — for builds that will be
// published — any missing asset (the worker, any WASM core variant, or either language model) is
// a hard error (exit 1) rather than a silently OCR-less deploy.
//
// ## Why `tesseract.js-core` looks "ahead of latest" (issue #185)
//
// `npm outdated` reports `tesseract.js-core` as Current 7.0.0 / Latest 6.1.2 — the registry's
// `latest` dist-tag is *lower* than what we install. That is a dist-tag artefact upstream, not a
// version we drifted onto by accident, and the pin is deliberate:
//
//   * `tesseract.js@7` — itself the registry `latest` — declares `tesseract.js-core: ^7.0.0` as a
//     hard dependency, so core 7 is the only core the wrapper we ship will accept.
//   * Upstream published core 7.0.0 and then, minutes later, a 6.1.x patch for the Node-14
//     compatibility line. `npm publish` moves `latest` to whatever it published last regardless of
//     semver order, so the tag ended up pointing back at 6.x.
//   * Core 7 is where the relaxed-SIMD builds live (Emscripten 4.0.15); 6.1.2 ships no
//     `tesseract-core-relaxedsimd*` files at all.
//
// So do **not** "correct" the range down to the registry's `latest`: on a relaxed-SIMD-capable
// browser the worker would request a core variant that no longer exists and OCR would 404 on
// exactly those devices. `tesseract-core-pairing.test.ts` fails the build if the two majors ever
// drift apart, and `CORE_VARIANTS` below fails a published build that stages an incomplete set.

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
/** Treat missing assets as a build-breaking error (used by the deploy workflow). */
const require_ = process.argv.includes('--require');

/**
 * The English language models, one directory per accuracy tier (the user chooses at runtime;
 * `fast` is the default). `tessdata_fast` is the small integer model; the higher-accuracy tier
 * is `tessdata_best` (LSTM). Both are OEM-1 compatible, and both are user-selectable, so a
 * published build needs both. Served uncompressed, so the engine loads them with `gzip: false`.
 */
const MODELS = [
  ['fast', 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata'],
  ['best', 'https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata'],
];

/**
 * Every WASM core variant Tesseract's worker can select at runtime, by base name. The worker picks
 * exactly one and `importScripts` it as `<base>.wasm.js` — chosen by the device's relaxed-SIMD /
 * SIMD support and whether the LSTM-only engine mode is in use — so a staged tree missing any one
 * of them 404s on precisely the devices that select it, while every other device works fine.
 * Checking for "at least one core" would therefore pass a deploy that is broken for a whole class
 * of browsers, which is the failure the `--require` gate exists to prevent.
 *
 * `tesseract-core-pairing.test.ts` asserts this list still matches the variants the installed
 * worker actually references, so an upstream core that adds or drops one fails the build.
 */
const CORE_VARIANTS = [
  'tesseract-core',
  'tesseract-core-lstm',
  'tesseract-core-simd',
  'tesseract-core-simd-lstm',
  'tesseract-core-relaxedsimd',
  'tesseract-core-relaxedsimd-lstm',
];

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
  //    never fetches a file we didn't stage — see CORE_VARIANTS for why the whole set matters
  //    rather than the one this machine happens to pick. It's git-ignored + precache-excluded,
  //    so the extra megabytes cost the repo and the offline shell nothing.
  const coreDir = pkgDir('tesseract.js-core');
  for (const file of readdirSync(coreDir)) {
    if (/\.(wasm|wasm\.js|js)$/.test(file) && file.startsWith('tesseract-core')) {
      stage(resolve(coreDir, file));
    }
  }

  // 3. The English language models (see MODELS) — one directory per accuracy tier.
  for (const [tier, url] of MODELS) {
    await download(url, `tessdata-${tier}/eng.traineddata`);
  }

  // 4. Report what actually landed on disk. `stage()`/`download()` return false both for
  //    "already present" and "failed", so the only trustworthy check is the tree itself —
  //    and it is what the browser will fetch at runtime.
  const missing = missingAssets();
  if (missing.length === 0) {
    console.log('[ocr] OCR assets ready in public/ocr/.');
    return;
  }

  const detail = `missing from public/ocr/: ${missing.join(', ')}`;
  if (require_) {
    // A published build must not ship an OCR feature that can never load — fail loudly.
    // `exitCode` rather than `exit(1)`: the latter tears the process down immediately and can
    // truncate a not-yet-flushed write when stdout is a pipe (i.e. under CI), losing the very
    // message that explains the failure.
    console.error(
      `[ocr] required OCR assets are absent (${detail}). On-device OCR is a shipped feature ` +
        'with a settings surface, so a build that omits these assets would advertise it and ' +
        'then fail at runtime. A missing language model means the tessdata repositories were ' +
        'unreachable — re-run the deploy. A missing core variant means the installed ' +
        '`tesseract.js-core` does not carry one the worker can select, so check that its major ' +
        'still matches `tesseract.js` (see CORE_VARIANTS above).',
    );
    process.exitCode = 1;
    return;
  }
  console.warn(
    `[ocr] on-device OCR will stay unavailable locally (${detail}). Re-run ` +
      '`npm run ocr:assets` when online.',
  );
}

/** True when `name` exists under OUT_DIR *and* has content — an empty file is not an asset. */
function staged(name) {
  const path = resolve(OUT_DIR, name);
  return existsSync(path) && statSync(path).size > 0;
}

/**
 * The staged assets Tesseract cannot start without, as human-readable names — empty when the
 * tree is complete. **Every** {@link CORE_VARIANTS} entry must be present as the `.wasm.js` file
 * the worker `importScripts`, not merely one of them: the worker selects a variant from the
 * device's capabilities, so a partial set is a feature that works on this machine and 404s on
 * someone else's. Emptiness counts as absence: a zero-byte file left by an interrupted earlier
 * run would otherwise pass the `--require` gate and ship exactly the broken feature the gate
 * exists to catch.
 */
function missingAssets() {
  return [
    staged('worker.min.js') ? null : 'worker.min.js',
    ...CORE_VARIANTS.map((base) => (staged(`${base}.wasm.js`) ? null : `${base}.wasm.js`)),
    ...MODELS.map(([tier]) =>
      staged(`tessdata-${tier}/eng.traineddata`) ? null : `tessdata-${tier}/eng.traineddata`,
    ),
  ].filter((name) => name !== null);
}

// Without `--require`, never fail the caller — OCR is an optional, opt-in feature locally
// (mirrors check-bundle-size.mjs). With it, an unexpected error is a failed build.
main().catch((err) => {
  if (require_) {
    console.error(`[ocr] setup failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.warn(`[ocr] setup skipped: ${err.message}`);
  process.exit(0);
});
