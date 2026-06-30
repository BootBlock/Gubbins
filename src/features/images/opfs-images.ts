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

/** One stored full-resolution image: its OPFS filename and raw bytes. */
export interface OpfsImageFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Read every high-resolution image file from OPFS (§2.7 Full Archive). Returns an empty
 * list when the directory does not exist or iteration is unsupported, so callers degrade
 * gracefully on platforms without the async-iterable OPFS directory handle.
 */
export async function readAllImages(): Promise<OpfsImageFile[]> {
  const files: OpfsImageFile[] = [];
  try {
    const dir = await imagesDirectory(false);
    // `entries()` is async-iterable on a FileSystemDirectoryHandle (not yet in lib.dom).
    const iterable = (dir as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries;
    if (typeof iterable !== 'function') return files;
    for await (const [name, handle] of iterable.call(dir)) {
      if (handle.kind !== 'file') continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      files.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
  } catch {
    // Directory absent or OPFS unavailable — nothing to archive.
  }
  return files;
}

/**
 * Sum the real on-disk size (bytes) of every full-resolution image file in OPFS, for
 * a *truer* Storage-Triage estimate than the row-count heuristic (spec §7.6.2). Reads
 * only each file's `size` (cheap metadata — no byte copy into memory). Returns `null`
 * when OPFS or the async-iterable directory handle is unavailable (e.g. happy-dom),
 * so the caller falls back to the per-row heuristic rather than reporting 0 bytes.
 */
export async function imagesBytesOnDisk(): Promise<number | null> {
  try {
    const dir = await imagesDirectory(false);
    const iterable = (dir as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries;
    if (typeof iterable !== 'function') return null;
    let total = 0;
    for await (const [, handle] of iterable.call(dir)) {
      if (handle.kind !== 'file') continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      total += file.size;
    }
    return total;
  } catch {
    // Directory absent (no images yet) or OPFS unavailable — let the caller decide.
    return null;
  }
}

/**
 * Write full-resolution image files back into OPFS (§2.7 archive restore — the inverse of
 * {@link readAllImages}). Used when re-hydrating a full archive onto a fresh device so the
 * detail-view full-res images return alongside the restored database. Each file keeps its
 * original name (the UUID the stored `images/<uuid>.webp` path points at), so it lines up
 * with `item_images.full_res_opfs_path` with no remapping. Returns the count written.
 */
export async function writeImageFiles(files: readonly OpfsImageFile[]): Promise<number> {
  if (files.length === 0) return 0;
  const dir = await imagesDirectory(true);
  let written = 0;
  for (const { name, bytes } of files) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes as BufferSource);
      written += 1;
    } finally {
      await writable.close();
    }
  }
  return written;
}

/**
 * Remove the entire OPFS `images/` directory and everything in it (the §3 "Erase my data"
 * full photo wipe / hard reset). Recursive so it drops every stored full-resolution file in
 * one call. Swallows a missing directory (and any OPFS unavailability) like the other helpers,
 * so erasing photos when none were ever saved is a harmless no-op.
 */
export async function removeImagesDirectory(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(IMAGES_DIR, { recursive: true });
  } catch {
    // Directory never created, or OPFS unavailable — nothing to remove.
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
