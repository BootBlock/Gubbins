/**
 * On-device OCR engine glue (feature-gap **G2**).
 *
 * Runs Tesseract.js entirely on-device — keyless, no cloud, no third-party CDN — mirroring
 * how the barcode scanner runs zxing WASM in a worker (spec §6.6, §2.4.3 native-first). The
 * heavy engine (worker + WASM core + language model) is **lazily imported** (`import('tesseract.js')`)
 * so it forms a separate chunk that never bloats the base bundle, and its assets are served
 * from our own origin under `/ocr/` — **precache-excluded** (see `injectManifest.globIgnores`)
 * and staged by `scripts/setup-ocr-assets.mjs`.
 *
 * The text→fields interpretation is the pure {@link ./receipt-ocr} seam; this file only turns
 * an image into raw text. The recogniser is injected through a factory so the run orchestration
 * ({@link runReceiptOcr}) is unit-testable without loading a real WASM worker.
 */

import { hasOcr } from '@/lib/env/feature-detection';
import { ocrAssetRoot } from './ocr-asset-cache';

export { hasOcr };

/** Language-model accuracy tier. `fast` (small integer model) is the default; `best` is larger. */
export type OcrModel = 'fast' | 'best';

/** The default model tier — the SSOT the preference + Settings control read from. */
export const DEFAULT_OCR_MODEL: OcrModel = 'fast';

/** Coerce an arbitrary persisted value to a valid {@link OcrModel} (defends the read site). */
export function normaliseOcrModel(value: unknown): OcrModel {
  return value === 'best' ? 'best' : DEFAULT_OCR_MODEL;
}

/** Progress of a running OCR pass, surfaced to the UI (`0`…`1`). */
export interface OcrProgress {
  /** Tesseract phase label, e.g. `loading language traits`, `recognizing text`. */
  readonly status: string;
  /** Fraction complete for the current phase (`0`…`1`). */
  readonly progress: number;
}

/** A one-shot recogniser: turn an image into text, then release its worker. */
export interface OcrRecognizer {
  recognize(image: Blob): Promise<string>;
  terminate(): Promise<void>;
}

/** Injected factory building a recogniser — the real one loads Tesseract; tests supply a fake. */
export type OcrRecognizerFactory = (opts: {
  readonly model: OcrModel;
  readonly onProgress?: (p: OcrProgress) => void;
}) => Promise<OcrRecognizer>;

/**
 * Resolve the origin-relative URLs of the staged OCR assets for a model tier. Pure so the
 * base-path wiring (the app is served under a sub-path, e.g. `/Gubbins/`) is unit-testable.
 * `corePath` is a directory — Tesseract appends the SIMD/OEM-appropriate core file itself.
 *
 * @internal Exported for unit tests only.
 */
export function ocrAssetPaths(
  base: string,
  model: OcrModel,
): {
  workerPath: string;
  corePath: string;
  langPath: string;
} {
  // Shared with the service worker's runtime cache, so the URLs the engine fetches are exactly
  // the ones the worker recognises and keeps for offline use ({@link ./ocr-asset-cache}).
  const root = ocrAssetRoot(base);
  return {
    workerPath: `${root}worker.min.js`,
    corePath: root,
    langPath: `${root}tessdata-${model}`,
  };
}

/**
 * The real Tesseract recogniser: lazily import the library, spawn a worker pointed at our
 * locally-served worker/core/model, and run in OEM 1 (LSTM-only, matching the staged cores).
 * `gzip: false` because the models are served uncompressed; `cacheMethod: 'none'` because the
 * assets are same-origin static files (the browser HTTP cache handles reuse — no IndexedDB
 * layer needed). Progress from both the model-load and recognise phases flows to `onProgress`.
 */
export const createTesseractRecognizer: OcrRecognizerFactory = async ({ model, onProgress }) => {
  const { createWorker, OEM } = await import('tesseract.js');
  const paths = ocrAssetPaths(import.meta.env.BASE_URL, model);
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: paths.workerPath,
    corePath: paths.corePath,
    langPath: paths.langPath,
    gzip: false,
    cacheMethod: 'none',
    logger: (m: { status: string; progress: number }) =>
      onProgress?.({ status: m.status, progress: m.progress }),
  });
  return {
    async recognize(image: Blob): Promise<string> {
      const { data } = await worker.recognize(image);
      return data.text;
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
};

/**
 * A friendly, user-facing label for a raw Tesseract progress `status` string (e.g.
 * `loading language traits`, `recognizing text`). Pure, so the copy is unit-testable and the
 * UI never leaks the engine's internal phase names.
 */
export function describeOcrStatus(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('recogniz') || s.includes('recognis')) return 'Reading the image…';
  if (s.includes('load') || s.includes('initial')) return 'Loading the recognition engine…';
  return 'Working…';
}

/**
 * A friendly message for an OCR failure — almost always the engine or language model failing
 * to load (the assets aren't staged, or the device is offline on first use). Pure.
 */
export function describeOcrError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch|network|load|404|failed to/i.test(message)) {
    return 'Couldn’t load the on-device recognition engine. Check you’re online for the first scan, then try again.';
  }
  return 'Couldn’t read that image. Try a clearer, well-lit photo.';
}

/**
 * Run one OCR pass over an image and return the raw recognised text. Always tears the worker
 * down afterwards (success or failure), so a scan leaves no engine resident. The recogniser is
 * injected (defaults to the real Tesseract one) so this orchestration is testable in isolation.
 */
export async function runReceiptOcr(
  image: Blob,
  options: {
    readonly model: OcrModel;
    readonly onProgress?: (p: OcrProgress) => void;
    readonly createRecognizer?: OcrRecognizerFactory;
  },
): Promise<string> {
  const factory = options.createRecognizer ?? createTesseractRecognizer;
  const recognizer = await factory({ model: options.model, onProgress: options.onProgress });
  try {
    return await recognizer.recognize(image);
  } finally {
    await recognizer.terminate();
  }
}
