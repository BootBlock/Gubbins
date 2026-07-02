import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDecoder,
  supportsWorkerDecode,
  supportsCanvasWorkerDecode,
  makeWorkerDecoder,
  makeCanvasWorkerDecoder,
  type ScannerEngine,
  type DecodeWorkerLike,
  type CapturedFrame,
} from './barcode-decoder';

/**
 * Engine-selection + off-thread orchestration for the tiered scanner decoder (spec §6.6):
 * native first, then the **Web Worker** WASM fallback, then a graceful no-op. The native
 * API and the worker are both faked so the selection and the frame round-trip are exercised
 * without real camera hardware, WASM, or a spawned worker.
 */

const g = globalThis as unknown as {
  BarcodeDetector?: unknown;
  OffscreenCanvas?: unknown;
  createImageBitmap?: unknown;
  Worker?: unknown;
  document?: unknown;
};

/** A fake <video> with a non-zero frame so the worker path attempts a decode. */
function fakeVideo(w = 640, h = 480): HTMLVideoElement {
  return { videoWidth: w, videoHeight: h } as unknown as HTMLVideoElement;
}

/** A transferable-looking fake frame with a spyable close(). */
function fakeBitmap() {
  return { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A captured RGBA frame from a fake 2-D canvas grab. */
function fakeFrame(w = 640, h = 480): CapturedFrame {
  return { rgba: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

/** A controllable fake decode worker: records posts, replies on demand. */
class FakeWorker implements DecodeWorkerLike {
  onmessage: DecodeWorkerLike['onmessage'] = null;
  onerror: DecodeWorkerLike['onerror'] = null;
  posts: Array<{ message: { id: number } & Record<string, unknown>; transfer: Transferable[] }> = [];
  terminated = false;
  constructor(private readonly auto?: (id: number) => string | null) {}
  postMessage(message: unknown, transfer: Transferable[]) {
    const msg = message as { id: number } & Record<string, unknown>;
    this.posts.push({ message: msg, transfer });
    if (this.auto) {
      const text = this.auto(msg.id);
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, text } }));
    }
  }
  /** Reply to the most recent post with the given text (manual mode). */
  reply(text: string | null) {
    const last = this.posts.at(-1);
    if (last) this.onmessage?.({ data: { id: last.message.id, text } });
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  delete g.BarcodeDetector;
});

describe('supportsWorkerDecode — capability gate (spec §6.6 / §2.4.3)', () => {
  const ok = { Worker: class {}, OffscreenCanvas: class {}, createImageBitmap: () => {} };

  it('is true only when Worker, OffscreenCanvas and createImageBitmap are all present', () => {
    expect(supportsWorkerDecode(ok)).toBe(true);
  });

  it('is false when the Worker constructor is missing', () => {
    expect(supportsWorkerDecode({ ...ok, Worker: undefined })).toBe(false);
  });

  it('is false when OffscreenCanvas is missing', () => {
    expect(supportsWorkerDecode({ ...ok, OffscreenCanvas: undefined })).toBe(false);
  });

  it('is false when createImageBitmap is missing or not callable', () => {
    expect(supportsWorkerDecode({ ...ok, createImageBitmap: undefined })).toBe(false);
    expect(supportsWorkerDecode({ ...ok, createImageBitmap: 'nope' })).toBe(false);
  });
});

describe('createDecoder — tiered engine selection (spec §6.6)', () => {
  it('prefers the native Barcode Detection API when present', async () => {
    const nativeDetect = vi.fn().mockResolvedValue([{ rawValue: 'NATIVE-CODE' }, { rawValue: '' }]);
    g.BarcodeDetector = class {
      detect = nativeDetect;
    };

    const decoder = await createDecoder();
    expect(decoder.engine).toBe<ScannerEngine>('native');
    // Empty rawValues are filtered out.
    expect(await decoder.detect(fakeVideo())).toEqual(['NATIVE-CODE']);
  });

  it('hints all four symbologies to the native detector by default (§6.6)', async () => {
    let formats: readonly string[] | undefined;
    g.BarcodeDetector = class {
      constructor(opts?: { formats?: readonly string[] }) {
        formats = opts?.formats;
      }
      detect = vi.fn().mockResolvedValue([]);
    };
    await createDecoder();
    expect(formats).toEqual(['qr_code', 'code_128', 'ean_13', 'code_39']);
  });

  it('narrows the native detector to a single symbology when requested (§6.6 single-format)', async () => {
    let formats: readonly string[] | undefined;
    g.BarcodeDetector = class {
      constructor(opts?: { formats?: readonly string[] }) {
        formats = opts?.formats;
      }
      detect = vi.fn().mockResolvedValue([]);
    };
    await createDecoder('qr_code');
    expect(formats).toEqual(['qr_code']);
  });

  it('degrades to a no-op decoder when native, worker and canvas-worker paths are all unavailable', async () => {
    delete g.BarcodeDetector;
    // No OffscreenCanvas/createImageBitmap → 'wasm' unsupported; no Worker → 'wasm-canvas'
    // unsupported too, so the only remaining tier is manual entry.
    delete g.OffscreenCanvas;
    delete g.createImageBitmap;
    const savedWorker = g.Worker;
    delete g.Worker;
    try {
      const decoder = await createDecoder();
      expect(decoder.engine).toBe<ScannerEngine>('none');
      expect(await decoder.detect(fakeVideo())).toEqual([]);
    } finally {
      g.Worker = savedWorker;
    }
  });
});

describe('makeWorkerDecoder — off-thread frame round-trip (spec §6.6)', () => {
  it('reports the wasm engine and transfers a captured bitmap to decode a code', async () => {
    const bitmap = fakeBitmap();
    const worker = new FakeWorker(() => 'WASM-CODE');
    const createBitmap = vi.fn().mockResolvedValue(bitmap);
    const decoder = makeWorkerDecoder({ spawnWorker: () => worker, createBitmap });

    expect(decoder.engine).toBe<ScannerEngine>('wasm');
    expect(await decoder.detect(fakeVideo())).toEqual(['WASM-CODE']);
    expect(createBitmap).toHaveBeenCalledOnce();
    // The bitmap is transferred (zero-copy), not structured-cloned.
    expect(worker.posts[0].transfer).toEqual([bitmap]);
    // The scan scope rides along so the worker hints the right symbology (default: all).
    expect(worker.posts[0].message).toMatchObject({ symbology: 'all' });
  });

  it('forwards the chosen symbology to the worker (§6.6 single-format)', async () => {
    const worker = new FakeWorker(() => null);
    const decoder = makeWorkerDecoder({
      spawnWorker: () => worker,
      createBitmap: async () => fakeBitmap(),
      symbology: 'code_128',
    });
    await decoder.detect(fakeVideo());
    expect(worker.posts[0].message).toMatchObject({ symbology: 'code_128' });
  });

  it('treats a no-code frame (worker replies null) as no codes', async () => {
    const worker = new FakeWorker(() => null);
    const decoder = makeWorkerDecoder({
      spawnWorker: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    expect(await decoder.detect(fakeVideo())).toEqual([]);
  });

  it('skips a frame with no dimensions yet (never captures or posts)', async () => {
    const worker = new FakeWorker(() => 'X');
    const createBitmap = vi.fn();
    const decoder = makeWorkerDecoder({ spawnWorker: () => worker, createBitmap });
    expect(await decoder.detect(fakeVideo(0, 0))).toEqual([]);
    expect(createBitmap).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it('is single-flight: a second decode while one is pending yields no codes', async () => {
    const worker = new FakeWorker(); // manual reply
    const decoder = makeWorkerDecoder({
      spawnWorker: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const first = decoder.detect(fakeVideo());
    const second = await decoder.detect(fakeVideo()); // inFlight → []
    expect(second).toEqual([]);
    await tick(); // let the first capture + post settle
    worker.reply('LATE-CODE');
    expect(await first).toEqual(['LATE-CODE']);
    expect(worker.posts).toHaveLength(1); // the skipped second never posted
  });

  it('fails soft when frame capture rejects', async () => {
    const worker = new FakeWorker(() => 'X');
    const decoder = makeWorkerDecoder({
      spawnWorker: () => worker,
      createBitmap: async () => {
        throw new Error('capture failed');
      },
    });
    expect(await decoder.detect(fakeVideo())).toEqual([]);
    expect(worker.posts).toHaveLength(0);
  });

  it('resolves the in-flight decode to no codes on a worker error', async () => {
    const worker = new FakeWorker(); // manual
    const decoder = makeWorkerDecoder({
      spawnWorker: () => worker,
      createBitmap: async () => fakeBitmap(),
    });
    const pending = decoder.detect(fakeVideo());
    await tick();
    worker.onerror?.({});
    expect(await pending).toEqual([]);
  });

  it('terminates the worker on dispose and abandons a pending decode', async () => {
    const bitmap = fakeBitmap();
    const worker = new FakeWorker(); // manual
    const decoder = makeWorkerDecoder({ spawnWorker: () => worker, createBitmap: async () => bitmap });
    const pending = decoder.detect(fakeVideo());
    decoder.dispose();
    expect(worker.terminated).toBe(true);
    await tick();
    expect(await pending).toEqual([]); // disposed mid-capture → closed bitmap, no codes
    expect(bitmap.close).toHaveBeenCalled();
    // A decode attempted after dispose is a no-op.
    expect(await decoder.detect(fakeVideo())).toEqual([]);
  });
});

describe('supportsCanvasWorkerDecode — main-thread-capture gate (spec §6.6, Safari < 16.4)', () => {
  const ok = { Worker: class {}, document: { createElement: () => {} } };

  it('is true when a Worker and a DOM document (2-D canvas) are present', () => {
    expect(supportsCanvasWorkerDecode(ok)).toBe(true);
  });

  it('does not require OffscreenCanvas or createImageBitmap (the whole point of this tier)', () => {
    // No OffscreenCanvas/createImageBitmap in `ok` at all, yet the gate still passes — this
    // path decodes main-thread-captured pixels in the worker, needing neither.
    expect(supportsCanvasWorkerDecode(ok)).toBe(true);
  });

  it('is false when the Worker constructor is missing', () => {
    expect(supportsCanvasWorkerDecode({ ...ok, Worker: undefined })).toBe(false);
  });

  it('is false with no DOM document (e.g. a non-browser environment)', () => {
    expect(supportsCanvasWorkerDecode({ ...ok, document: undefined })).toBe(false);
  });
});

describe('createDecoder — canvas-worker fallback selection (spec §6.6)', () => {
  it('selects the wasm-canvas engine when the worker path is gone but Worker + DOM remain', async () => {
    delete g.BarcodeDetector;
    // No OffscreenCanvas/createImageBitmap → 'wasm' unsupported, but happy-dom provides a
    // Worker + document, so the main-thread-capture tier ('wasm-canvas') resolves.
    delete g.OffscreenCanvas;
    delete g.createImageBitmap;
    g.Worker = class {
      postMessage() {}
      terminate() {}
      onmessage = null;
      onerror = null;
    };
    g.document = { createElement: () => ({}) };
    const decoder = await createDecoder();
    expect(decoder.engine).toBe<ScannerEngine>('wasm-canvas');
    decoder.dispose();
  });
});

describe('makeCanvasWorkerDecoder — main-thread capture, worker decode (spec §6.6)', () => {
  it('reports the wasm-canvas engine and transfers captured RGBA pixels to decode a code', async () => {
    const frame = fakeFrame();
    const worker = new FakeWorker(() => 'CANVAS-CODE');
    const captureFrame = vi.fn().mockReturnValue(frame);
    const decoder = makeCanvasWorkerDecoder({ spawnWorker: () => worker, captureFrame });

    expect(decoder.engine).toBe<ScannerEngine>('wasm-canvas');
    expect(await decoder.detect(fakeVideo())).toEqual(['CANVAS-CODE']);
    expect(captureFrame).toHaveBeenCalledOnce();
    // The pixel buffer is transferred (zero-copy), and the message carries its dimensions
    // and scan scope.
    expect(worker.posts[0].transfer).toEqual([frame.rgba.buffer]);
    expect(worker.posts[0].message).toMatchObject({ width: 640, height: 480, symbology: 'all' });
  });

  it('forwards the chosen symbology to the worker (§6.6 single-format)', async () => {
    const worker = new FakeWorker(() => null);
    const decoder = makeCanvasWorkerDecoder({
      spawnWorker: () => worker,
      captureFrame: () => fakeFrame(),
      symbology: 'ean_13',
    });
    await decoder.detect(fakeVideo());
    expect(worker.posts[0].message).toMatchObject({ symbology: 'ean_13' });
  });

  it('treats a no-code frame (worker replies null) as no codes', async () => {
    const worker = new FakeWorker(() => null);
    const decoder = makeCanvasWorkerDecoder({
      spawnWorker: () => worker,
      captureFrame: () => fakeFrame(),
    });
    expect(await decoder.detect(fakeVideo())).toEqual([]);
  });

  it('skips a frame the canvas grab cannot read (capture returns null — never posts)', async () => {
    const worker = new FakeWorker(() => 'X');
    const captureFrame = vi.fn().mockReturnValue(null); // e.g. no 2-D context
    const decoder = makeCanvasWorkerDecoder({ spawnWorker: () => worker, captureFrame });
    expect(await decoder.detect(fakeVideo())).toEqual([]);
    expect(captureFrame).toHaveBeenCalledOnce();
    expect(worker.posts).toHaveLength(0);
  });

  it('skips a frame with no dimensions yet (never captures or posts)', async () => {
    const worker = new FakeWorker(() => 'X');
    const captureFrame = vi.fn();
    const decoder = makeCanvasWorkerDecoder({ spawnWorker: () => worker, captureFrame });
    expect(await decoder.detect(fakeVideo(0, 0))).toEqual([]);
    expect(captureFrame).not.toHaveBeenCalled();
    expect(worker.posts).toHaveLength(0);
  });

  it('is single-flight: a second decode while one is pending yields no codes', async () => {
    const worker = new FakeWorker(); // manual reply
    const decoder = makeCanvasWorkerDecoder({
      spawnWorker: () => worker,
      captureFrame: () => fakeFrame(),
    });
    const first = decoder.detect(fakeVideo());
    const second = await decoder.detect(fakeVideo()); // inFlight → []
    expect(second).toEqual([]);
    await tick();
    worker.reply('LATE-CANVAS');
    expect(await first).toEqual(['LATE-CANVAS']);
    expect(worker.posts).toHaveLength(1);
  });

  it('terminates the worker on dispose and is a no-op afterwards', async () => {
    const worker = new FakeWorker(() => 'X');
    const decoder = makeCanvasWorkerDecoder({
      spawnWorker: () => worker,
      captureFrame: () => fakeFrame(),
    });
    decoder.dispose();
    expect(worker.terminated).toBe(true);
    expect(await decoder.detect(fakeVideo())).toEqual([]);
  });
});
