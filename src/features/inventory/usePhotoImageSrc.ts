/**
 * `usePhotoImageSrc` — resolve a location photo into an object URL a `RegionCanvas` can render
 * (issue #81).
 *
 * Three call sites need the same three-step fallback, so it lives here once rather than being
 * repeated (and mis-repeated) in each:
 *
 * 1. **The full-resolution WebP from OPFS** (§4.2.2) — the file the regions were drawn over.
 * 2. **The stored thumbnail**, when that file is absent. `readImageBlob` resolves to `undefined`
 *    for a missing file, which is the *expected* case on a peer device: only the thumbnail syncs,
 *    the raw bytes never do. The overlay is still correct at that size because geometry is
 *    normalised and the natural dimensions are stored on the row.
 * 3. **Nothing** — `src` stays `null` and the caller renders a placeholder rather than a broken
 *    image.
 *
 * The object URL is **always revoked** on cleanup, including when the read resolves after the
 * effect has already been torn down — otherwise every dialog open would leak a blob for the
 * lifetime of the tab. The URL is created inside the effect and published through state (never
 * during render), so the committed `<img>` only ever references a still-live URL — the same
 * discipline `Thumbnail` uses against StrictMode's double invoke.
 */
import { useEffect, useState } from 'react';
import { readImageBlob } from '@/features/images/opfs-images';

/** The subset of a `LocationPhoto` this hook needs — so a caller may pass a narrower row. */
export interface PhotoImageSourceInput {
  readonly fullResOpfsPath: string;
  readonly thumbnailBlob: Uint8Array | null;
}

export interface PhotoImageSource {
  /** An object URL for the best available rendition, or `null` when there is none. */
  readonly src: string | null;
  /** True while the OPFS read is in flight — distinguishes "loading" from "genuinely absent". */
  readonly loading: boolean;
}

/**
 * Wrap stored thumbnail bytes in a Blob. The bytes are copied into a fresh `ArrayBuffer` first:
 * BLOBs can arrive `SharedArrayBuffer`-backed from the OPFS worker, which the `Blob` constructor
 * refuses.
 */
function blobFromThumbnail(bytes: Uint8Array | null): Blob | null {
  if (!bytes || bytes.byteLength === 0) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: 'image/webp' });
}

export function usePhotoImageSrc(photo: PhotoImageSourceInput | null | undefined): PhotoImageSource {
  // Depend on the primitive path and the bytes rather than the row object, so a re-fetch that
  // returns an equal-but-new row does not re-read OPFS and churn the object URL.
  const path = photo?.fullResOpfsPath ?? null;
  const thumbnail = photo?.thumbnailBlob ?? null;

  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (path === null) {
      setSrc(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let url: string | null = null;
    setSrc(null);
    setLoading(true);

    void (async () => {
      // A read failure is treated exactly like a missing file: fall back, never throw.
      let blob: Blob | undefined;
      try {
        blob = await readImageBlob(path);
      } catch {
        blob = undefined;
      }
      const resolved = blob ?? blobFromThumbnail(thumbnail);
      // The effect was torn down while the read was in flight — publish nothing, allocate nothing.
      if (cancelled) return;
      if (!resolved) {
        setLoading(false);
        return;
      }
      url = URL.createObjectURL(resolved);
      setSrc(url);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, thumbnail]);

  return { src, loading };
}
