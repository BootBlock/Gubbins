/**
 * Native OPFS raw-file storage for high-resolution images (spec §4.2.3).
 *
 * Per the Anti-Base64 Directive (§4.2.1) the full-resolution WebP bytes must never
 * enter SQLite. They live as raw files in a dedicated OPFS subdirectory, written
 * and read on the *main thread* via the native OPFS API — entirely bypassing the
 * database worker. Only the relative path string ever crosses the RPC bridge to be
 * stored in `item_images.full_res_opfs_path`.
 *
 * Browser-only (depends on `navigator.storage.getDirectory`); exercised by the
 * real-browser smoke test (§8.5.5), not the `:memory:` unit suite.
 */

/** OPFS subdirectory holding the high-resolution image files. */
const IMAGES_DIR = 'images';

async function imagesDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(IMAGES_DIR, { create });
}

/** Extract the bare filename from a stored `images/<uuid>.webp` path. */
function filenameOf(path: string): string | undefined {
  const name = path.split('/').pop();
  return name && name.length > 0 ? name : undefined;
}

/**
 * Write a compressed image blob to OPFS as a new raw file, returning its relative
 * path (e.g. `images/3f2c…​.webp`) for storage via the ImageRepository.
 */
export async function saveImageFile(blob: Blob, extension = 'webp'): Promise<string> {
  const dir = await imagesDirectory(true);
  const filename = `${crypto.randomUUID()}.${extension}`;
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  return `${IMAGES_DIR}/${filename}`;
}

/**
 * Read a high-resolution image back from OPFS as a Blob (for the detail view).
 * Returns `undefined` when the file is missing (e.g. synced from another device).
 */
export async function readImageBlob(path: string): Promise<Blob | undefined> {
  const filename = filenameOf(path);
  if (!filename) return undefined;
  try {
    const dir = await imagesDirectory(false);
    const handle = await dir.getFileHandle(filename, { create: false });
    return await handle.getFile();
  } catch {
    return undefined;
  }
}

/** Delete a raw image file from OPFS. Silently ignores an already-missing file. */
export async function deleteImageFile(path: string): Promise<void> {
  const filename = filenameOf(path);
  if (!filename) return;
  try {
    const dir = await imagesDirectory(false);
    await dir.removeEntry(filename);
  } catch {
    // Already gone, or the directory was never created — nothing to reclaim.
  }
}
