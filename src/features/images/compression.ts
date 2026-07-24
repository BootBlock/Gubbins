/**
 * Client-side image compression pipeline (spec §4.2.3).
 *
 * Before any image reaches the database worker, the React layer draws it to a
 * canvas, downsamples it, and re-encodes it as efficient WebP — never passing raw
 * multi-megabyte camera photos across the RPC bridge. This produces two artefacts:
 *  - `fullRes` — the ≤1080px WebP, saved as a raw OPFS file (never the DB, §4.2.1).
 *  - `thumbnailBytes` — a ≤150px WebP as bytes, the only image data the DB stores
 *    (`item_images.thumbnail_blob`), kept tiny for list rendering (§4.2.2/§4.2.4).
 *
 * Browser-only (depends on `createImageBitmap`/`<canvas>`), so it is validated by
 * the real-browser smoke test (§8.5.5) rather than the `:memory:` unit suite.
 */

/** Maximum dimension of the stored high-resolution image (spec §4.2.3). */
const MAX_FULL_DIMENSION = 1080;
/** Maximum dimension of the list thumbnail (spec §4.2.2). */
const MAX_THUMB_DIMENSION = 150;
const FULL_QUALITY = 0.8; // §4.2.3 canvas.toBlob(..., 'image/webp', 0.8)
const THUMB_QUALITY = 0.7;

/**
 * Cap for an `IMAGE` custom-field cover (issue #453). Larger than a list thumbnail so a
 * cover reads cleanly at detail size, but small enough that the base64 value stays well
 * under the field's byte ceiling — the whole image lives in the synced DB, not OPFS.
 */
const MAX_FIELD_IMAGE_DIMENSION = 512;
const FIELD_IMAGE_QUALITY = 0.75;

export interface ProcessedImage {
  /** The downsampled high-resolution WebP, destined for a raw OPFS file. */
  readonly fullRes: Blob;
  /** The tiny thumbnail WebP as bytes, destined for `item_images.thumbnail_blob`. */
  readonly thumbnailBytes: Uint8Array;
}

/** Compress a picked image file into a full-res WebP blob and a thumbnail. */
export async function processImageFile(file: Blob): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const fullRes = await encodeScaled(bitmap, MAX_FULL_DIMENSION, FULL_QUALITY);
    const thumb = await encodeScaled(bitmap, MAX_THUMB_DIMENSION, THUMB_QUALITY);
    const thumbnailBytes = new Uint8Array(await thumb.arrayBuffer());
    return { fullRes, thumbnailBytes };
  } finally {
    bitmap.close();
  }
}

/**
 * Compress a picked image into a single bounded WebP `data:` URL for storage in an `IMAGE`
 * custom field (issue #453). Unlike {@link processImageFile}, there is no OPFS full-res and
 * no separate thumbnail — the field holds this one compressed image directly in the database
 * value, so it must stay small (see `MAX_FIELD_IMAGE_BYTES`). Browser-only (canvas/WebP).
 */
export async function encodeFieldImage(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const webp = await encodeScaled(bitmap, MAX_FIELD_IMAGE_DIMENSION, FIELD_IMAGE_QUALITY);
    return await blobToDataUrl(webp);
  } finally {
    bitmap.close();
  }
}

/** Read a blob into a `data:` URL (base64) via FileReader. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image data.'));
    reader.readAsDataURL(blob);
  });
}

/** Scale-down dimensions preserving aspect ratio; never upscales below the cap. */
function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Draw the bitmap downsampled to `maxDim` and encode it as a WebP blob. */
async function encodeScaled(bitmap: ImageBitmap, maxDim: number, quality: number): Promise<Blob> {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to acquire a 2D canvas context for image compression.');
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image WebP encoding failed.'))),
      'image/webp',
      quality,
    );
  });
}
