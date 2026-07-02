/**
 * Barcode decoding engine selection (spec §6.6, §2.4.3 native-first).
 *
 * Tiered, native-first decoding:
 *  - **Primary:** the modern native **Barcode Detection API**, which offloads to the
 *    device's hardware (battery + framerate). Used whenever `BarcodeDetector` exists.
 *  - **WASM fallback — off-thread, OffscreenCanvas (`'wasm'`):** when the native API is absent
 *    (Firefox, Safari ≥ 16.4) we run a zxing decoder in a **Web Worker** (see
 *    {@link ./barcode-decode.worker}). The frame is captured to an `ImageBitmap` and
 *    transferred in, so the CPU-heavy decode never blocks the main thread.
 *  - **WASM fallback — main-thread capture, worker decode (`'wasm-canvas'`):** for browsers
 *    without `OffscreenCanvas` (Safari < 16.4) we capture the frame on the main thread with a
 *    regular 2-D `<canvas>` (the API those browsers *do* have) and transfer the **raw RGBA
 *    pixels** to the *same* decode worker — so the heavy decode still runs off-thread and the
 *    worker's `@zxing/library` chunk is **reused** rather than duplicated into the main bundle.
 *
 * The worker is referenced lazily via `new Worker(new URL(...))` so its zxing chunk is a
 * separate module graph that never bloats the default bundle. All engines are wrapped in one
 * uniform per-frame {@link FrameDecoder}, so the polling loop in {@link useScanner} is identical
 * regardless of which resolved. Everything is feature-detected and fails soft (a transient
 * decode error yields no codes, not a throw); a browser with no native API and no `Worker`/DOM
 * canvas degrades to manual entry (`engine: 'none'`).
 */
import { hasBarcodeDetector } from '@/lib/env/feature-detection';
import { DEFAULT_SCANNER_SYMBOLOGY, nativeFormatsFor, type ScannerSymbology } from './scanner-formats';

/** Which decoding engine backs the live scanner. `none` → manual entry only. */
export type ScannerEngine = 'native' | 'wasm' | 'wasm-canvas' | 'none';

export interface FrameDecoder {
  readonly engine: ScannerEngine;
  /** Decode any codes in the current video frame; `[]` when none found or on error. */
  detect(source: HTMLVideoElement): Promise<string[]>;
  /** Release any retained resources (worker / reader). Safe to call repeatedly. */
  dispose(): void;
}

// Minimal typing for the experimental Barcode Detection API (not in lib.dom yet).
interface DetectedBarcode {
  readonly rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
}

/** A decoder that finds nothing — the graceful "no engine" state (manual entry only). */
const NO_DECODER: FrameDecoder = {
  engine: 'none',
  detect: async () => [],
  dispose: () => {},
};

/** Wrap the native Barcode Detection API, or return null when unsupported. */
function makeNativeDecoder(symbology: ScannerSymbology): FrameDecoder | null {
  if (!hasBarcodeDetector()) return null;
  try {
    const Ctor = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: nativeFormatsFor(symbology) });
    return {
      engine: 'native',
      async detect(source) {
        try {
          const codes = await detector.detect(source);
          return codes.map((c) => c.rawValue).filter((v) => v.length > 0);
        } catch {
          return []; // transient detect failures are ignored; the loop continues
        }
      },
      dispose() {},
    };
  } catch {
    return null;
  }
}

/** The globals the off-thread decode path needs. Injectable so the gate is pure-testable. */
export interface WorkerDecodeGlobals {
  readonly Worker?: unknown;
  readonly OffscreenCanvas?: unknown;
  readonly createImageBitmap?: unknown;
}

/**
 * True when the off-thread WASM decode path is available: a `Worker` to host zxing, an
 * `OffscreenCanvas` to read pixels in that worker, and `createImageBitmap` to capture a
 * transferable frame on the main thread. All three are needed; missing any → fall through
 * to manual entry (spec §6.6 / §2.4.3 feature-detect-everything).
 */
export function supportsWorkerDecode(env: WorkerDecodeGlobals = globalThis): boolean {
  return (
    typeof env.Worker !== 'undefined' &&
    typeof env.OffscreenCanvas !== 'undefined' &&
    typeof env.createImageBitmap === 'function'
  );
}

/** The globals the main-thread-capture decode path needs. Injectable so the gate is pure-testable. */
export interface CanvasWorkerGlobals {
  readonly Worker?: unknown;
  readonly document?: { createElement?: unknown };
}

/**
 * True when the main-thread-capture fallback is available: a `Worker` to host the zxing
 * decode and a DOM `document` to mint a 2-D `<canvas>` for frame capture. This is the path
 * for browsers with no native API and no `OffscreenCanvas` (Safari < 16.4): the worker decodes
 * the pixels the main thread reads off the canvas, so it needs neither `OffscreenCanvas` nor
 * `createImageBitmap`. (spec §6.6 / §2.4.3 feature-detect-everything.)
 */
export function supportsCanvasWorkerDecode(env: CanvasWorkerGlobals = globalThis): boolean {
  return (
    typeof env.Worker !== 'undefined' &&
    typeof env.document !== 'undefined' &&
    typeof env.document?.createElement === 'function'
  );
}

/** The minimal slice of `Worker` the decoder drives — injectable for tests. */
export interface DecodeWorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: { data: { id: number; text: string | null } }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/** A frame captured into a transferable worker message, or `null` to skip this frame. */
interface PreparedFrame {
  /** The id-correlated payload posted to the worker. */
  readonly message: unknown;
  /** The zero-copy transfer list (the bitmap, or the RGBA buffer). */
  readonly transfer: Transferable[];
  /** Free the captured resource if the decode is abandoned before it is posted. */
  release(): void;
}

/** Shared dependencies of every worker-backed decoder, injected so the round-trip is unit-testable. */
interface WorkerBackedDeps {
  /** The engine label this decoder reports. */
  readonly engine: ScannerEngine;
  /** Spawn the decode worker (may throw — construction failure → no decoder). */
  spawnWorker: () => DecodeWorkerLike;
  /** Capture the current frame into a transferable message (or `null` to skip it). */
  prepareFrame: (source: HTMLVideoElement, id: number) => Promise<PreparedFrame | null>;
}

/**
 * The shared engine behind both off-thread fallbacks: capture a frame (via `prepareFrame`),
 * transfer it to the worker, and resolve when it replies with the id-correlated result.
 * Single-flight — `useScanner` awaits each `detect` before the next, and an explicit guard
 * skips overlap. Fails soft: a capture/worker error yields no codes, never a throw.
 */
function makeWorkerBackedDecoder(deps: WorkerBackedDeps): FrameDecoder {
  const worker = deps.spawnWorker();
  let nextId = 1;
  let inFlight = false;
  let disposed = false;
  const pending = new Map<number, (text: string | null) => void>();

  worker.onmessage = ({ data }) => {
    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve(data.text);
    }
  };
  worker.onerror = () => {
    // A worker-level error fails the in-flight decode softly (no codes), never throws.
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };

  return {
    engine: deps.engine,
    async detect(source) {
      if (disposed || inFlight) return [];
      if (source.videoWidth === 0 || source.videoHeight === 0) return [];
      inFlight = true;
      try {
        const id = nextId++;
        let frame: PreparedFrame | null;
        try {
          frame = await deps.prepareFrame(source, id);
        } catch {
          return []; // frame capture failed transiently — skip this frame
        }
        if (!frame) return []; // nothing to decode this frame (e.g. no canvas context)
        if (disposed) {
          frame.release();
          return [];
        }
        const text = await new Promise<string | null>((resolve) => {
          pending.set(id, resolve);
          worker.postMessage(frame.message, frame.transfer);
        });
        return text ? [text] : [];
      } finally {
        inFlight = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      worker.terminate();
    },
  };
}

/** Dependencies of the OffscreenCanvas worker decoder, injected so the round-trip is unit-testable. */
export interface WorkerDecoderDeps {
  /** Spawn the decode worker (may throw — construction failure → no decoder). */
  spawnWorker: () => DecodeWorkerLike;
  /** Capture the current video frame as a transferable bitmap (off the main thread). */
  createBitmap: (source: HTMLVideoElement) => Promise<ImageBitmap>;
  /** Which symbology the worker should hint (default: all four, §6.6). */
  symbology?: ScannerSymbology;
}

/**
 * Build the `'wasm'` (OffscreenCanvas) decoder: capture each frame to an `ImageBitmap` and
 * transfer it in; the worker rasterises and decodes it off-thread. The chosen `symbology`
 * rides on each request so the worker hints only the wanted format(s) (§6.6).
 */
export function makeWorkerDecoder(deps: WorkerDecoderDeps): FrameDecoder {
  const symbology = deps.symbology ?? DEFAULT_SCANNER_SYMBOLOGY;
  return makeWorkerBackedDecoder({
    engine: 'wasm',
    spawnWorker: deps.spawnWorker,
    prepareFrame: async (source, id) => {
      const bitmap = await deps.createBitmap(source);
      return {
        message: { id, symbology, bitmap },
        transfer: [bitmap],
        release: () => bitmap.close(),
      };
    },
  });
}

/** A frame's RGBA pixels read off a 2-D canvas on the main thread. */
export interface CapturedFrame {
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Dependencies of the main-thread-capture decoder, injected so the round-trip is unit-testable. */
export interface CanvasWorkerDecoderDeps {
  /** Spawn the decode worker (may throw — construction failure → no decoder). */
  spawnWorker: () => DecodeWorkerLike;
  /** Read the current video frame's RGBA pixels via a 2-D canvas (`null` to skip the frame). */
  captureFrame: (source: HTMLVideoElement) => CapturedFrame | null;
  /** Which symbology the worker should hint (default: all four, §6.6). */
  symbology?: ScannerSymbology;
}

/**
 * Build the `'wasm-canvas'` decoder (Safari < 16.4): capture each frame's RGBA pixels on the
 * main thread (a regular 2-D `<canvas>`) and transfer them to the *same* worker, which decodes
 * them without needing `OffscreenCanvas`. The heavy decode still runs off-thread; only the
 * cheap canvas draw + `getImageData` is on the main thread. The chosen `symbology` rides on
 * each request so the worker hints only the wanted format(s) (§6.6).
 */
export function makeCanvasWorkerDecoder(deps: CanvasWorkerDecoderDeps): FrameDecoder {
  const symbology = deps.symbology ?? DEFAULT_SCANNER_SYMBOLOGY;
  return makeWorkerBackedDecoder({
    engine: 'wasm-canvas',
    spawnWorker: deps.spawnWorker,
    prepareFrame: async (source, id) => {
      const frame = deps.captureFrame(source);
      if (!frame) return null;
      // `getImageData` returns a fresh buffer each call, so transferring it is safe.
      return {
        message: { id, symbology, rgba: frame.rgba, width: frame.width, height: frame.height },
        transfer: [frame.rgba.buffer],
        release: () => {},
      };
    },
  });
}

/**
 * Production wiring of the off-thread OffscreenCanvas decoder: gate on the required globals,
 * then spawn the real Vite-bundled worker and capture frames with `createImageBitmap`. Returns
 * null when the path is unavailable, so {@link createDecoder} falls through.
 */
function makeWorkerWasmDecoder(symbology: ScannerSymbology): FrameDecoder | null {
  if (!supportsWorkerDecode()) return null;
  try {
    return makeWorkerDecoder({
      spawnWorker: spawnDecodeWorker,
      createBitmap: (source) => createImageBitmap(source),
      symbology,
    });
  } catch {
    return null;
  }
}

/**
 * Production wiring of the main-thread-capture decoder (no `OffscreenCanvas`): gate on
 * `Worker` + a DOM canvas, then spawn the same Vite-bundled worker and read frames off a
 * reused 2-D `<canvas>`. Returns null when unavailable, so {@link createDecoder} falls through
 * to manual entry.
 */
function makeCanvasWorkerWasmDecoder(symbology: ScannerSymbology): FrameDecoder | null {
  if (!supportsCanvasWorkerDecode()) return null;
  try {
    return makeCanvasWorkerDecoder({
      spawnWorker: spawnDecodeWorker,
      captureFrame: makeCanvasCapture(),
      symbology,
    });
  } catch {
    return null;
  }
}

/**
 * The exact `new Worker(new URL(...), { type: 'module' })` form Vite statically detects to
 * bundle the decode worker as a separate module graph. Shared by both off-thread engines so
 * the zxing chunk is referenced once.
 */
function spawnDecodeWorker(): DecodeWorkerLike {
  return new Worker(new URL('./barcode-decode.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as DecodeWorkerLike;
}

/**
 * A reused-canvas frame grabber: draw the live `<video>` onto one 2-D `<canvas>` (resized to
 * the frame) and read back its RGBA pixels. Returns `null` for an unsized frame or a browser
 * with no 2-D context, so the decoder simply skips it.
 */
function makeCanvasCapture(): (source: HTMLVideoElement) => CapturedFrame | null {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  return (source) => {
    const width = source.videoWidth;
    const height = source.videoHeight;
    if (width === 0 || height === 0) return null;
    if (!canvas) canvas = document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx ??= canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    return { rgba: data, width, height };
  };
}

/**
 * Resolve the best available decoding engine (spec §6.6): native first, then the off-thread
 * OffscreenCanvas worker (`'wasm'`), then the main-thread-capture worker for no-OffscreenCanvas
 * browsers (`'wasm-canvas'`, Safari < 16.4), then a no-op decoder (manual entry only). Always
 * resolves — callers inspect `.engine` to tailor the UI.
 *
 * `symbology` (default: all four) scopes which formats every tier hints — a single-format scope
 * is the §6.6 single-format mode, cutting per-frame decode cost on the worker fallbacks.
 */
export async function createDecoder(
  symbology: ScannerSymbology = DEFAULT_SCANNER_SYMBOLOGY,
): Promise<FrameDecoder> {
  const native = makeNativeDecoder(symbology);
  if (native) return native;
  const worker = makeWorkerWasmDecoder(symbology);
  if (worker) return worker;
  const canvasWorker = makeCanvasWorkerWasmDecoder(symbology);
  return canvasWorker ?? NO_DECODER;
}
