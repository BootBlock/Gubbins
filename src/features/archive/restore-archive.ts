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
import { unzipSync } from 'fflate';
import { disposeDatabase } from '@/db/client';
import {
  isSqliteFile,
  overwriteOpfsDatabase,
  prepareDestructiveRestore,
  StaleJournalError,
  type RestoreOptions,
} from '@/app/error/safe-mode-actions';
import { writeImageFiles, type OpfsImageFile } from '@/features/images/opfs-images';
import { ARCHIVE_DB_ENTRY, ARCHIVE_IMAGES_PREFIX } from './auto-archive';

/** The decoded contents of a full archive: the database binary and its image files. */
export interface ArchiveContents {
  readonly sqlite: Uint8Array;
  readonly images: OpfsImageFile[];
}

/** Thrown when an archive is malformed (not a zip, or missing/invalid database). */
export class InvalidArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchiveError';
  }
}

/**
 * Split an unzipped `path → bytes` archive map into its database binary and image files.
 * Pure. Throws {@link InvalidArchiveError} when the SQLite entry is absent or is not a
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
  return { sqlite, images };
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

/**
 * Restore a full archive (`.zip`) onto this device (§2.7 / §3). **Destructive** — the
 * caller must confirm first. Unzips the archive, checks the archived database is sound and
 * saves a restore point of the current one (issue #198), then overwrites the OPFS database,
 * re-hydrates the full-resolution images and reloads so the worker re-opens the restored
 * database. Throws {@link InvalidArchiveError} for a malformed archive, or
 * `DamagedDatabaseError` / `RestorePointError` from the pre-flight — all before any OPFS write.
 */
export async function restoreArchive(file: File, options: RestoreOptions = {}): Promise<void> {
  const zip = new Uint8Array(await file.arrayBuffer());
  const { sqlite, images } = readArchive(zip); // validates before we touch OPFS
  await prepareDestructiveRestore(sqlite, options);

  await disposeDatabase();

  // The database bytes commit before the old session's sidecars are cleared, so a
  // `StaleJournalError` means the restore *did* land and only the cleanup failed. Finish
  // re-hydrating the images so both halves match the archive, then surface it instead of
  // reloading — opening the restored file beside a hot journal would roll it back (#203).
  let staleJournal: StaleJournalError | undefined;
  try {
    await overwriteOpfsDatabase(sqlite);
  } catch (error) {
    if (!(error instanceof StaleJournalError)) throw error;
    staleJournal = error;
  }
  await writeImageFiles(images);
  if (staleJournal) throw staleJournal;

  location.reload();
}
