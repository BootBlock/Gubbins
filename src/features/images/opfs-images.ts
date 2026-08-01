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
 *
 * These writes bypass the database worker entirely, so a `QuotaExceededError` here reaches none of
 * the plumbing that watches SQLite — and the full-resolution WebP is by far the largest thing the
 * app writes, which makes this the surface most likely to hit the ceiling first. Both writers below
 * report the failure to `features/storage/exhaustion` on the way past (issue #504).
 */
import { reportStorageFailure } from '@/features/storage/exhaustion';

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
 * path (e.g. `images/3f2c….webp`) for storage via the ImageRepository.
 *
 * `close()` sits inside the `try`, and a failure aborts instead: OPFS *stages* a write, so a quota
 * error normally surfaces at `close()` rather than at `write()` — closing from a `finally` would
 * both commit a partial file on a device that has no room for it and let the close's own failure
 * mask the quota error the caller (and the tier) needs to see.
 */
export async function saveImageFile(blob: Blob, extension = 'webp'): Promise<string> {
  const path = reserveImagePath(extension);
  const dir = await imagesDirectory(true);
  const filename = filenameOf(path)!;
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    // Best-effort: the stream may already be errored, and that must not mask the real failure.
    await writable.abort?.().catch(() => {});
    reportStorageFailure(error);
    throw error;
  }
  return path;
}

/**
 * Mint the relative path a full-resolution file *would* occupy, without writing anything.
 *
 * Used when the storage tier refuses the full-resolution write (see `full-res-policy`): the
 * `full_res_opfs_path` column is NOT NULL, so a thumbnail-only row still needs a well-formed
 * path — one that points at a file which does not exist, exactly like a row Storage Triage has
 * already downgraded. Callers **must** pair this with `full_res_downgraded_at`, or the row
 * claims a full-resolution image it never had.
 */
export function reserveImagePath(extension = 'webp'): string {
  return `${IMAGES_DIR}/${crypto.randomUUID()}.${extension}`;
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
    const iterable = (
      dir as unknown as {
        entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries;
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
 * List the bare filenames of every full-resolution image file in OPFS, without
 * reading any bytes (cheap directory metadata only). Used by the Database
 * Maintenance orphan sweep to find raw files no `item_images` row points at (left
 * behind if a DB write failed after the OPFS file landed — see the media pipeline).
 * Returns `null` when OPFS or the async-iterable directory handle is unavailable
 * (e.g. happy-dom), so the caller can report "unsupported" rather than delete
 * against an empty list. An absent `images/` directory is an empty list (`[]`).
 */
export function listImageFilenames(): Promise<string[] | null> {
  return listImageFilenamesFiltered();
}

/**
 * As {@link listImageFilenames}, but omitting any file modified within the last `minAgeMs`
 * (measured against `now`). This is the list the **automatic** orphan sweep works from
 * (issue #206): the media pipeline writes the raw OPFS file *before* committing its
 * `item_images` row, so a just-written file legitimately has no owning row for a brief
 * window — excluding young files keeps a background sweep from deleting an image that is
 * still mid-add. A genuinely orphaned file is caught on a later sweep once it has aged past
 * the margin. The manual sweep passes no age filter (the user triggered it deliberately, and
 * it reports what it removed), so it still sees every file.
 */
export function listImageFilenamesOlderThan(minAgeMs: number, now: number): Promise<string[] | null> {
  return listImageFilenamesFiltered({ minAgeMs, now });
}

async function listImageFilenamesFiltered(age?: { minAgeMs: number; now: number }): Promise<string[] | null> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await imagesDirectory(false);
  } catch {
    // Absent images/ directory (nothing stored yet) reads as an empty sweep, but only
    // if OPFS itself is available — otherwise we must report "unsupported" (null) so the
    // caller never deletes against a falsely-empty list.
    try {
      await navigator.storage.getDirectory();
      return [];
    } catch {
      return null;
    }
  }
  const iterable = (
    dir as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    }
  ).entries;
  if (typeof iterable !== 'function') return null;
  const names: string[] = [];
  for await (const [name, handle] of iterable.call(dir)) {
    if (handle.kind !== 'file') continue;
    if (age) {
      // Reading the file yields its `lastModified` (cheap metadata, no byte copy).
      const file = await (handle as FileSystemFileHandle).getFile();
      if (age.now - file.lastModified < age.minAgeMs) continue;
    }
    names.push(name);
  }
  return names;
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
    const iterable = (
      dir as unknown as {
        entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries;
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

/** What a re-hydration run could not manage: the files that did not land, and why. */
export interface ImageWriteReport {
  /** The names of the files that could not be written, in the order they were attempted. */
  readonly failed: readonly string[];
  /** The first failure, so a caller can chain it as a `cause` for diagnostics. */
  readonly failure?: unknown;
}

/**
 * Write full-resolution image files back into OPFS (§2.7 archive restore — the inverse of
 * {@link readAllImages}). Used when re-hydrating a full archive onto a fresh device so the
 * detail-view full-res images return alongside the restored database. Each file keeps its
 * original name (the UUID the stored `images/<uuid>.webp` path points at), so it lines up
 * with `item_images.full_res_opfs_path` with no remapping.
 *
 * **Reports rather than throws** (issue #639). Every caller runs this *after* the restored
 * database has already committed, so there is nothing left to unwind: abandoning the remaining
 * files on the first failure would lose images the device had room for, and letting the failure
 * propagate would have the caller announce a restore that had in fact already happened. A file
 * that cannot be written is named in {@link ImageWriteReport.failed} and the run carries on —
 * sizes vary, so the file after the one that exhausted the quota may well still fit.
 */
export async function writeImageFiles(files: readonly OpfsImageFile[]): Promise<ImageWriteReport> {
  if (files.length === 0) return { failed: [] };

  let dir: FileSystemDirectoryHandle;
  try {
    dir = await imagesDirectory(true);
  } catch (error) {
    // No directory means no file can land; report the whole set rather than throwing, so the
    // caller still finishes and reports the restore that already committed. Creating the
    // directory is itself a write, so the tier hears about it either way (issue #504).
    reportStorageFailure(error);
    return { failed: files.map((file) => file.name), failure: error };
  }

  const failed: string[] = [];
  let failure: unknown;
  for (const { name, bytes } of files) {
    try {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      // Same close-inside-the-try contract as `saveImageFile`: re-hydrating an archive writes
      // every full-resolution image this device has, so it is the likeliest of all of them to
      // run out — and the bytes are not committed to the file until the stream closes, so a
      // close that fails is a file that did not land.
      try {
        await writable.write(bytes as BufferSource);
        await writable.close();
      } catch (error) {
        // Best-effort: the stream may already be errored, and that must not mask the real
        // failure. `abort()` is also what releases the scratch copy's space, which matters most
        // in the case that put us here (a full disk).
        await writable.abort?.().catch(() => {});
        throw error;
      }
    } catch (error) {
      failed.push(name);
      failure ??= error;
      // The tier watches this too (issue #504). Reported per file rather than once at the end:
      // the run continues past a failure now, so the last error is not necessarily the one that
      // ran the device out of room.
      reportStorageFailure(error);
      await discardEmptyFile(dir, name);
    }
  }
  return { failed, failure };
}

/**
 * Remove `name` from the images directory if the failed write left it empty.
 *
 * `getFileHandle(…, { create: true })` mints the directory entry before a single byte is
 * written, and aborting the stream discards only its scratch copy — so without this a write
 * that failed leaves a zero-byte file behind. That is *worse* than no file at all:
 * {@link readImageBlob} would hand back an empty blob rather than the `undefined` that makes
 * callers fall back to the stored thumbnail, so a photo the device merely lacked would render
 * broken instead, and the next backup would carry the empty file forward.
 *
 * Only an empty entry is removed. An aborted write over an image this device already held
 * leaves the original bytes intact (the swap copy never reaches the file), and those must
 * survive — a merge restore that ran out of room must not delete the photos already there.
 */
async function discardEmptyFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    const handle = await dir.getFileHandle(name, { create: false });
    if ((await handle.getFile()).size > 0) return;
    await dir.removeEntry(name);
  } catch {
    // No entry (the failure came before one was made), or OPFS refused — either way there is
    // nothing useful to do, and this must never displace the write failure being reported.
  }
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
