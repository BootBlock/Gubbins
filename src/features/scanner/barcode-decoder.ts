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
 *
 * **A dead worker stays dead, and every frame is bounded (issue #678.)** That lazy chunk can fail
 * to load — a stale tab whose hashed chunk the new build dropped (the case `stale-chunk-reload`
 * exists for), a half-propagated deploy — and the browser can reclaim a worker under memory
 * pressure. Neither makes `new Worker(...)` throw, because module loading is asynchronous, so the
 * decoder is handed out looking healthy and only the `error` event says otherwise. Left unlatched,
 * the next frame posts into a worker that can never receive it, waits for a reply that never comes,
 * and the single-flight guard sticks — a live viewfinder over an engine that silently decodes
 * nothing for the rest of the session. So a worker-level error latches {@link FrameDecoder.failed},
 * and each frame's round trip carries a {@link DECODE_TIMEOUT_MS} budget.
 */
import { hasBarcodeDetector } from '@/lib/env/feature-detection';
import { computeCoverRoi, type FrameRoi } from './roi';
import { DEFAULT_SCANNER_SYMBOLOGY, nativeFormatsFor, type ScannerSymbology } from './scanner-formats';

/** Which decoding engine backs the live scanner. `none` → manual entry only. */
export type ScannerEngine = 'native' | 'wasm' | 'wasm-canvas' | 'none';

/**
 * What the scanner reports to its UI: the {@link ScannerEngine} that resolved, plus `failed` for
 * one that resolved and then died under it (issue #678). Deliberately not the same as `none` —
 * `none` means this browser never had a live engine and never will, while `failed` means the one
 * it had stopped working and a reload is likely to bring it back. Both steer to manual entry, but
 * only one of them is worth retrying.
 */
export type ScannerEngineStatus = ScannerEngine | 'failed';

/**
 * How long one frame may go unanswered by the decode worker before it is abandoned (issue #678).
 * Generous by design: this exists to convert an infinite wait into "no codes this frame", not to
 * police a slow decode, so a false positive on a genuinely slow device is the failure worth
 * avoiding — a real zxing decode is orders of magnitude quicker than this.
 *
 * A timeout deliberately does **not** latch the decoder (the same call `worker-driver.ts` makes
 * for a database RPC): one unanswered frame is not proof the worker is gone, and the next frame
 * simply tries again. Only an `error` event is proof.
 *
 * @internal Exported for unit tests only.
 */
export const DECODE_TIMEOUT_MS = 10_000;

/**
 * Resolve the source-pixel {@link FrameRoi} to analyse for a frame, or `null` to decode the whole
 * frame. Injected so the engines stay decoupled from where the crop comes from (the reticle box in
 * production, {@link computeCoverRoi} by default, a fixed rect in tests).
 */
export type ComputeRoi = (source: HTMLVideoElement) => FrameRoi | null;

export interface FrameDecoder {
  readonly engine: ScannerEngine;
  /**
   * True once this decoder has died and can never decode again — its worker failed to load or was
   * reclaimed (issue #678). Every later {@link detect} short-circuits, and {@link useScanner}
   * watches this to stop polling and report `failed`, so the user is steered to manual entry
   * instead of a viewfinder that cannot work. Never true for an engine that simply found no code.
   */
  readonly failed: boolean;
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
  // Absent, not broken: there was never an engine here to lose.
  failed: false,
  detect: async () => [],
  dispose: () => {},
};

/**
 * A reused 2-D canvas that crops a video frame to a {@link FrameRoi} for the native detector
 * (issue #59) — so the detector sees only the visible viewfinder region, where a centred
 * barcode is large relative to the analysed pixels. Returns `null` with no DOM/context, so the
 * caller falls back to detecting the raw frame.
 */
function makeVideoCropper(): (source: CanvasImageSource, roi: FrameRoi) => HTMLCanvasElement | null {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  return (source, roi) => {
    if (typeof document === 'undefined') return null;
    canvas ??= document.createElement('canvas');
    if (canvas.width !== roi.sw) canvas.width = roi.sw;
    if (canvas.height !== roi.sh) canvas.height = roi.sh;
    ctx ??= canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, roi.sx, roi.sy, roi.sw, roi.sh, 0, 0, roi.sw, roi.sh);
    return canvas;
  };
}

/** Wrap the native Barcode Detection API, or return null when unsupported. */
function makeNativeDecoder(symbology: ScannerSymbology, computeRoi: ComputeRoi): FrameDecoder | null {
  if (!hasBarcodeDetector()) return null;
  try {
    const Ctor = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: nativeFormatsFor(symbology) });
    const crop = makeVideoCropper();
    return {
      engine: 'native',
      // Hardware-backed and in-process: a detect that throws is transient, never terminal.
      failed: false,
      async detect(source) {
        try {
          // Decode only the reticle region (issue #59) — or the visible viewfinder region — when
          // the crop is a real subset; otherwise detect the raw frame unchanged.
          const roi = computeRoi(source);
          const input = roi ? (crop(source, roi) ?? source) : source;
          const codes = await detector.detect(input);
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
 *
 * @internal Exported for unit tests only.
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

/** A frame awaiting its worker reply, with the timer that bounds the wait. */
interface PendingDecode {
  readonly resolve: (text: string | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The shared engine behind both off-thread fallbacks: capture a frame (via `prepareFrame`),
 * transfer it to the worker, and resolve when it replies with the id-correlated result.
 * Single-flight — `useScanner` awaits each `detect` before the next, and an explicit guard
 * skips overlap. Fails soft: a capture/worker error yields no codes, never a throw.
 *
 * Every wait is bounded and a worker failure is terminal (issue #678) — see the module docblock.
 */
function makeWorkerBackedDecoder(deps: WorkerBackedDeps): FrameDecoder {
  const worker = deps.spawnWorker();
  let nextId = 1;
  let inFlight = false;
  let disposed = false;
  /** Latched once the worker can never answer again, so `detect` stops posting into a corpse. */
  let failed = false;
  const pending = new Map<number, PendingDecode>();

  /** Settle one awaited frame and disarm its timeout; a reply for anything else is dropped. */
  const settle = (id: number, text: string | null) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(text);
  };

  /** Abandon every awaited frame as "no codes", disarming their timeouts. */
  const abandonPending = () => {
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    pending.clear();
  };

  worker.onmessage = ({ data }) => settle(data.id, data.text);
  worker.onerror = () => {
    // A worker-level error fails the in-flight decode softly (no codes), never throws — and
    // latches (issue #678). Latching is the whole point: the error that matters is a worker
    // that failed to load or was reclaimed, which can never receive another message, so
    // without this the next frame posts into a dead worker and waits for ever.
    failed = true;
    abandonPending();
  };

  return {
    engine: deps.engine,
    get failed() {
      return failed;
    },
    async detect(source) {
      if (disposed || failed || inFlight) return [];
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
        // Re-checked after the await: the worker can have died (or been disposed) while the
        // frame was being captured, and posting the capture into it would strand this decode.
        if (disposed || failed) {
          frame.release();
          return [];
        }
        const captured = frame;
        const text = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => settle(id, null), DECODE_TIMEOUT_MS);
          pending.set(id, { resolve, timer });
          try {
            worker.postMessage(captured.message, captured.transfer);
          } catch {
            // The frame could not be handed over (an unclonable or already-detached payload), so
            // nothing will ever answer this id. Settle it now rather than waiting out the budget,
            // and free the capture the worker never took. Deliberately not a throw: a rejected
            // `detect` would take the caller's polling loop down with it.
            captured.release();
            settle(id, null);
          }
        });
        return text ? [text] : [];
      } finally {
        inFlight = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abandonPending();
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
 *
 * @internal Exported for unit tests only.
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
 *
 * @internal Exported for unit tests only.
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
function makeWorkerWasmDecoder(symbology: ScannerSymbology, computeRoi: ComputeRoi): FrameDecoder | null {
  if (!supportsWorkerDecode()) return null;
  try {
    return makeWorkerDecoder({
      spawnWorker: spawnDecodeWorker,
      // Crop the captured bitmap to the reticle / visible viewfinder region (issue #59), so the
      // worker decodes where the barcode actually is rather than a near-full landscape frame.
      createBitmap: (source) => {
        const roi = computeRoi(source);
        return roi ? createImageBitmap(source, roi.sx, roi.sy, roi.sw, roi.sh) : createImageBitmap(source);
      },
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
function makeCanvasWorkerWasmDecoder(
  symbology: ScannerSymbology,
  computeRoi: ComputeRoi,
): FrameDecoder | null {
  if (!supportsCanvasWorkerDecode()) return null;
  try {
    return makeCanvasWorkerDecoder({
      spawnWorker: spawnDecodeWorker,
      captureFrame: makeCanvasCapture(computeRoi),
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
function makeCanvasCapture(computeRoi: ComputeRoi): (source: HTMLVideoElement) => CapturedFrame | null {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  return (source) => {
    if (source.videoWidth === 0 || source.videoHeight === 0) return null;
    // Capture only the reticle / visible viewfinder region (issue #59); otherwise the whole
    // frame. `sw`/`sh` are the analysed image's dimensions.
    const roi = computeRoi(source);
    const sx = roi?.sx ?? 0;
    const sy = roi?.sy ?? 0;
    const width = roi?.sw ?? source.videoWidth;
    const height = roi?.sh ?? source.videoHeight;
    if (!canvas) canvas = document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx ??= canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, width, height, 0, 0, width, height);
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
 *
 * `computeRoi` (default {@link computeCoverRoi}) is the source-pixel crop every tier analyses —
 * the reticle box in production (issue #59), so a framed barcode is large relative to the analysed
 * pixels on any viewport shape.
 */
export async function createDecoder(
  symbology: ScannerSymbology = DEFAULT_SCANNER_SYMBOLOGY,
  computeRoi: ComputeRoi = computeCoverRoi,
): Promise<FrameDecoder> {
  const native = makeNativeDecoder(symbology, computeRoi);
  if (native) return native;
  const worker = makeWorkerWasmDecoder(symbology, computeRoi);
  if (worker) return worker;
  const canvasWorker = makeCanvasWorkerWasmDecoder(symbology, computeRoi);
  return canvasWorker ?? NO_DECODER;
}
