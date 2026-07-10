/**
 * Catalogue letterhead / branding helpers (issue #22 follow-up).
 *
 * A company can dress the printed parts catalogue with a logo, an organisation name + address,
 * a custom title and a footer. Those settings persist in `usePreferencesStore` (localStorage),
 * so the logo must be a **small** self-contained `data:` URL, not a multi-megabyte camera photo.
 * {@link logoToDataUrl} downsamples a picked image on a canvas — the same approach as the item
 * image pipeline (`@/features/images/compression`) — to a compact WebP data URL a few KB in size.
 *
 * The canvas path is browser-only (`createImageBitmap` / `<canvas>`), so it is exercised by the
 * production build + manual verification, not the `:memory:` unit suite. The pure
 * {@link normaliseCatalogueLogo} guard *is* unit-tested.
 */

/** Longest-edge cap for the stored logo — small enough to keep the data URL a few KB. */
const MAX_LOGO_DIMENSION = 320;
/** WebP quality for the stored logo (mirrors the full-image quality in `compression.ts`). */
const LOGO_QUALITY = 0.8;

/**
 * Downscale a picked image file to a compact `data:image/webp` URL suitable for persisting in
 * localStorage-backed preferences. Preserves aspect ratio and never upscales below the cap.
 */
export async function logoToDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > MAX_LOGO_DIMENSION ? MAX_LOGO_DIMENSION / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to acquire a 2D canvas context for the catalogue logo.');
    ctx.drawImage(bitmap, 0, 0, width, height);

    return canvas.toDataURL('image/webp', LOGO_QUALITY);
  } finally {
    bitmap.close();
  }
}

/**
 * Guard a persisted logo value: only a `data:image/…` URL is allowed to reach the `<img>` tag;
 * anything else (a stale/garbage value, a non-image URL) normalises to `''` (no logo). Keeps a
 * corrupt persisted preference from ever rendering a broken or unexpected image.
 */
export function normaliseCatalogueLogo(value: unknown): string {
  return typeof value === 'string' && value.startsWith('data:image/') ? value : '';
}
