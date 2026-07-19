import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { OCR_ASSET_CACHE, OCR_ASSET_GENERATION, isOcrAssetUrl } from './ocr-asset-cache';
import { ocrAssetPaths } from './ocr-engine';

const require_ = createRequire(import.meta.url);

describe('OCR asset cache — generation tracks the installed Tesseract', () => {
  /**
   * The staged assets are unhashed copies of Tesseract's dist files, so an upgrade republishes
   * `worker.min.js` and the WASM cores at the same URLs. Cache-first would then keep serving the
   * old worker to the newly-bundled library — a broken engine, offline *and* online. Pinning the
   * generation to the dependency's version turns "upgraded Tesseract, forgot the cache name" from
   * a silent runtime break into a failed build.
   */
  it('matches the installed tesseract.js version', () => {
    const { version } = require_('tesseract.js/package.json') as { version: string };
    expect(OCR_ASSET_GENERATION).toBe(version);
  });

  it('matches the installed tesseract.js-core version (the WASM cores are staged from it)', () => {
    const { version } = require_('tesseract.js-core/package.json') as { version: string };
    expect(OCR_ASSET_GENERATION).toBe(version);
  });

  it('names a cache distinct from the app-shell precache', () => {
    expect(OCR_ASSET_CACHE).toContain(OCR_ASSET_GENERATION);
    expect(OCR_ASSET_CACHE).not.toBe('gubbins-precache-v1');
  });
});

describe('isOcrAssetUrl', () => {
  const scope = 'https://example.test/Gubbins/sw.js';

  it.each([
    'https://example.test/Gubbins/ocr/worker.min.js',
    'https://example.test/Gubbins/ocr/tesseract-core-simd-lstm.wasm',
    'https://example.test/Gubbins/ocr/tessdata-best/eng.traineddata',
  ])('matches the staged asset %s', (url) => {
    expect(isOcrAssetUrl(new URL(url), scope)).toBe(true);
  });

  it.each([
    // App-shell assets must keep going through the precache, not the OCR cache.
    'https://example.test/Gubbins/assets/index-abc123.js',
    'https://example.test/Gubbins/index.html',
    // A same-named directory outside the app's base path is somebody else's.
    'https://example.test/ocr/worker.min.js',
    // Cross-origin never lands in our runtime cache, however it is spelled.
    'https://elsewhere.test/Gubbins/ocr/worker.min.js',
  ])('does not match %s', (url) => {
    expect(isOcrAssetUrl(new URL(url), scope)).toBe(false);
  });

  /**
   * The engine and the worker must agree on where the assets live. If they ever drift — the engine
   * fetching from a directory the worker no longer routes — every existing test still passes while
   * OCR silently stops working offline again, which is precisely the failure this whole change
   * exists to fix. So assert the agreement directly, on the URLs the engine really hands Tesseract.
   */
  it.each(['fast', 'best'] as const)('recognises every URL the engine requests for the %s model', (model) => {
    const base = '/Gubbins/';
    const scope = new URL(base, 'https://example.test').href;
    const paths = ocrAssetPaths(base, model);

    for (const path of [
      paths.workerPath,
      `${paths.corePath}tesseract-core.wasm`,
      `${paths.langPath}/eng.traineddata`,
    ]) {
      expect(isOcrAssetUrl(new URL(path, 'https://example.test'), scope)).toBe(true);
    }
  });

  it('tracks a root-served deployment (self-hosted, no base path)', () => {
    expect(
      isOcrAssetUrl(new URL('https://example.test/ocr/worker.min.js'), 'https://example.test/sw.js'),
    ).toBe(true);
  });
});
