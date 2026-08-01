/**
 * Full-archive restore (§2.7 / §3) — re-hydrate a fresh device from a `.zip` archive.
 *
 * The §2.7 weekly Full Archive ({@link buildFullArchive}) packs the raw SQLite binary
 * *and* every full-resolution OPFS image into one `.zip`. Raw `.sqlite` restore
 * (`restoreRawSqlite`) re-imports the database (thumbnails included) but leaves the
 * full-resolution image files behind, so a fresh-device restore silently lost them. This
 * closes the loop: unzip the archive, overwrite the OPFS database **and** write the
 * full-resolution images back into OPFS, then reload.
 *
 * The unzip→parse pipeline ({@link readArchive} / {@link parseArchive}) is pure and
 * fully unit-tested; only {@link restoreArchive} touches OPFS + the worker (browser-only,
 * exercised by the smoke).
 */
import { unzipSync, strFromU8 } from 'fflate';
import {
  IncompatibleDatabaseError,
  isSqliteFile,
  overwriteDatabaseFile,
  prepareDestructiveRestore,
  StaleJournalError,
  type RestoreOptions,
} from '@/app/error/safe-mode-actions';
import { BASELINE_REVISION } from '@/db/migrations';
import { writeImageFiles, type OpfsImageFile } from '@/features/images/opfs-images';
import {
  ARCHIVE_DB_ENTRY,
  ARCHIVE_IMAGES_PREFIX,
  ARCHIVE_MANIFEST_ENTRY,
  ARCHIVE_MANIFEST_KIND,
  type ArchiveManifest,
} from './auto-archive';

/** The decoded contents of a full archive: the database binary, its image files and its manifest. */
export interface ArchiveContents {
  readonly sqlite: Uint8Array;
  readonly images: OpfsImageFile[];
  /**
   * What the archive says about itself (issue #501), or `null` where it says nothing readable —
   * archives written before `manifest.json` existed, and any whose manifest is damaged.
   *
   * Absent is *benign* here, unlike a backup's manifest (issue #353), because this one is never
   * the only check: it is a worker-free head start on the stamp read from the database bytes, and
   * an archive without it is assessed exactly as one was before manifests existed. That is a
   * weaker position, not an open door — where no worker can start, the bytes-level read reports
   * `unverified` and such an archive still passes, which is precisely the hole the manifest
   * narrows rather than closes. See {@link ArchiveManifest}.
   */
  readonly manifest: ArchiveManifest | null;
}

/** Thrown when an archive is malformed (not a zip, or missing/invalid database). */
export class InvalidArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
  }
}

/**
 * Split an unzipped `path → bytes` archive map into its database binary, image files and
 * manifest. Pure. Throws {@link InvalidArchiveError} when the SQLite entry is absent or is not a
 * genuine SQLite file (so a stray/corrupt zip can never overwrite the live database with
 * junk). Bare directory markers and any nested `images/<dir>/…` entries are ignored — only
 * the flat `images/<uuid>.webp` files the archive writes are re-hydrated.
 */
export function parseArchive(entries: Record<string, Uint8Array>): ArchiveContents {
  const sqlite = entries[ARCHIVE_DB_ENTRY];
  if (!sqlite) {
    throw new InvalidArchiveError(`Archive is missing its database (${ARCHIVE_DB_ENTRY}).`);
  }
  if (!isSqliteFile(sqlite)) {
    throw new InvalidArchiveError('The archived database is not a valid SQLite file.');
  }

  const images: OpfsImageFile[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith(ARCHIVE_IMAGES_PREFIX)) continue;
    const name = path.slice(ARCHIVE_IMAGES_PREFIX.length);
    if (name.length === 0 || name.includes('/')) continue; // directory marker / nested path
    images.push({ name, bytes });
  }
  return { sqlite, images, manifest: readManifestEntry(entries[ARCHIVE_MANIFEST_ENTRY]) };
}

/**
 * Decode the archive's `manifest.json`, or `null` where there isn't a usable one.
 *
 * Deliberately forgiving, unlike the backup codec's manifest: this one only ever *adds* a
 * refusal, so treating a damaged one as "no manifest" leaves the archive exactly as well checked
 * as one written before manifests existed — whereas rejecting the archive over it would strand a
 * user whose database is fine. Every field is checked before it is trusted, since a zip is
 * whatever was put in it.
 */
function readManifestEntry(bytes: Uint8Array | undefined): ArchiveManifest | null {
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.kind !== ARCHIVE_MANIFEST_KIND) return null;
  if (typeof candidate.formatVersion !== 'number') return null;
  if (typeof candidate.appVersion !== 'string') return null;
  if (typeof candidate.baselineRevision !== 'string') return null;
  if (typeof candidate.createdAt !== 'string') return null;
  const counts = candidate.counts;
  if (typeof counts !== 'object' || counts === null) return null;
  const images = (counts as Record<string, unknown>).images;
  if (typeof images !== 'number' || !Number.isFinite(images)) return null;
  return {
    kind: ARCHIVE_MANIFEST_KIND,
    formatVersion: candidate.formatVersion,
    appVersion: candidate.appVersion,
    baselineRevision: candidate.baselineRevision,
    createdAt: candidate.createdAt,
    counts: { images },
  };
}

/**
 * Unzip a full-archive `.zip` and parse it into its contents. Pure (no OPFS/worker).
 * Throws {@link InvalidArchiveError} for bytes that are not a valid zip.
 */
export function readArchive(zip: Uint8Array): ArchiveContents {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new InvalidArchiveError('That file is not a valid .zip archive.');
  }
  return parseArchive(entries);
}

/** What a completed archive restore left behind for the caller to say (issue #639). */
export interface ArchiveRestoreOutcome {
  /** How many full-resolution images the archive carried. */
  readonly images: number;
  /** How many of them could not be written back to this device — 0 on a clean restore. */
  readonly imagesMissed: number;
}

/**
 * Restore a full archive (`.zip`) onto this device (§2.7 / §3). **Destructive** — the
 * caller must confirm first. Unzips the archive, checks the archived database is sound and
 * saves a restore point of the current one (issue #198), then replaces the stored database,
 * re-hydrates the full-resolution images and reloads so the worker re-opens the restored
 * database. Throws {@link InvalidArchiveError} for a malformed archive, or
 * `DamagedDatabaseError` / `IncompatibleDatabaseError` / `RestorePointError` /
 * `RestorePointNotSavedError` from the pre-flight — all before any OPFS write.
 *
 * **Reloads itself only on a clean restore** (issue #639). Where an image could not be written
 * the database is already replaced and the worker already released, so this returns instead —
 * the shortfall is the caller's to report, and the reload is the caller's to offer once it has
 * been read. Returning is never a failure: by this point the archive's data *is* this device's
 * data, whatever the image count says.
 */
export async function restoreArchive(file: File, options: RestoreOptions): Promise<ArchiveRestoreOutcome> {
  const zip = new Uint8Array(await file.arrayBuffer());
  const { sqlite, images, manifest } = readArchive(zip); // validates before we touch OPFS

  // Issue #501: the archive's own stamp, checked ahead of the pre-flight because it needs no
  // worker. That matters here — this restore is reached from the crash screen, where a worker
  // that will not start is the ordinary case, and it is exactly the case where the stamp read
  // from the database bytes comes back `unverified` and waves the file through.
  if (!options.force && manifest && manifest.baselineRevision !== BASELINE_REVISION) {
    throw new IncompatibleDatabaseError();
  }

  await prepareDestructiveRestore(sqlite, options);

  // The database bytes commit before the old session's sidecars are cleared, so a
  // `StaleJournalError` means the restore *did* land and only the cleanup failed. Finish
  // re-hydrating the images so both halves match the archive, then surface it instead of
  // reloading — opening the restored file beside a hot journal would roll it back (#203).
  let staleJournal: StaleJournalError | undefined;
  try {
    await overwriteDatabaseFile(sqlite);
  } catch (error) {
    if (!(error instanceof StaleJournalError)) throw error;
    staleJournal = error;
  }
  const report = await writeImageFiles(images);
  if (report.failed.length > 0) {
    // The count is all the sentence the user gets; keep the reason for the console.
    console.warn(
      `[gubbins] archive restore: ${report.failed.length} of ${images.length} images could not be written`,
      report.failure,
    );
  }
  if (staleJournal) throw staleJournal;

  if (report.failed.length === 0) location.reload();
  return { images: images.length, imagesMissed: report.failed.length };
}
