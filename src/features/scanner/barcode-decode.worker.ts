/**
 * Off-main-thread barcode decode worker (spec §6.6, §2.4.3 native-first).
 *
 * The §6.6 WASM fallback (used when the native Barcode Detection API is absent) runs the
 * CPU-heavy zxing decode **here**, off the main thread, so live scanning never janks the
 * UI. It serves two fallback engines, both decoding through the shared {@link createZxingDecode}:
 *
 *  - **`'wasm'` (OffscreenCanvas path, Phase 31):** the main thread captures each frame to an
 *    `ImageBitmap` and transfers it in; this worker draws it onto a reused `OffscreenCanvas`,
 *    reads back its RGBA pixels and decodes them.
 *  - **`'wasm-canvas'` (main-thread-capture path, Phase 33):** for browsers without
 *    `OffscreenCanvas` (Safari < 16.4) the main thread captures the frame with a regular 2-D
 *    `<canvas>` and transfers the **raw RGBA pixels**; this worker decodes them directly,
 *    **never touching `OffscreenCanvas`** — so the same worker (and its zxing chunk) is reused
 *    on a browser that cannot construct one.
 *
 * A frame with no code yields `null` (zxing's `NotFoundException` is swallowed as "no codes"),
 * mirroring the main-thread decoder's fail-soft contract.
 */
import { createZxingDecode, type RgbaDecoder } from './zxing-decode';
import { type ScannerSymbology } from './scanner-formats';

/** A frame captured to an `ImageBitmap` (the OffscreenCanvas worker path). */
interface BitmapRequest {
  readonly id: number;
  readonly symbology: ScannerSymbology;
  readonly bitmap: ImageBitmap;
}
/** A frame captured to raw RGBA pixels on the main thread (the no-OffscreenCanvas path). */
interface RgbaRequest {
  readonly id: number;
  readonly symbology: ScannerSymbology;
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}
type DecodeRequest = BitmapRequest | RgbaRequest;

interface DecodeResponse {
  readonly id: number;
  readonly text: string | null;
}

// The reader is built lazily and memoised by symbology: a scanner session keeps one
// symbology, so this rebuilds the hinted reader at most once (on the first frame, or if the
// scan scope ever changes). A single-format scope means ~4× cheaper per-frame decode (§6.6).
let decodeRgba: RgbaDecoder | null = null;
let decoderSymbology: ScannerSymbology | null = null;
function decoderFor(symbology: ScannerSymbology): RgbaDecoder {
  if (!decodeRgba || decoderSymbology !== symbology) {
    decodeRgba = createZxingDecode(symbology);
    decoderSymbology = symbology;
  }
  return decodeRgba;
}

// The OffscreenCanvas is built lazily and only for the bitmap path, so a browser without
// OffscreenCanvas can still drive the RGBA path through this worker.
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

/** Rasterise a transferred bitmap on the reused OffscreenCanvas, then decode its pixels. */
function decodeBitmap(bitmap: ImageBitmap, decode: RgbaDecoder): string | null {
  const { width, height } = bitmap;
  if (width === 0 || height === 0) return null;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d');
  }
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  return decode(data, width, height);
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const data = event.data;
  let text: string | null = null;
  try {
    const decode = decoderFor(data.symbology);
    if ('bitmap' in data) {
      try {
        text = decodeBitmap(data.bitmap, decode);
      } finally {
        data.bitmap.close();
      }
    } else {
      text = decode(data.rgba, data.width, data.height);
    }
  } catch {
    text = null;
  }
  const response: DecodeResponse = { id: data.id, text };
  (self as unknown as Worker).postMessage(response);
};
