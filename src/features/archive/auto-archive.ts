/**
 * §2.7 Mobile weekly "Full Archive Download" (Phase 14).
 *
 * The File System Access API is unsupported on iOS/Android, so mobile users without
 * active Cloud Sync have no auto-save safety net. The spec mandates a **weekly prompt**
 * to download a full archive — the OPFS SQLite binary *and* the OPFS image files — as a
 * single `.zip` to the device's Downloads folder, mirroring the JSON backup's role but
 * carrying the heavy blobs the §4 strict-isolation JSON deliberately omits.
 *
 * The schedule decision ({@link isArchiveDue}) is pure and unit-tested; the byte-gathering
 * and zip are browser-only (OPFS + the fflate worker) and exercised by the smoke.
 */
import { getDatabaseDriver } from '@/db/client';
import { BASELINE_REVISION } from '@/db/migrations';
import { readAllImages } from '@/features/images/opfs-images';
import { APP_VERSION } from '@/lib/app-version';
import { downloadBlob, fileTimestamp } from '@/lib/download';
import type { VaultZipRequest, VaultZipResponse } from '@/features/export/export-vault.worker';

/**
 * Weekly cadence (§2.7 "weekly prompt").
 *
 * @internal Exported for unit tests only.
 */
export const ARCHIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long dismissing the weekly-backup banner hides it for. A dismissal is a "not now" —
 * the prompt returns after this window if a fresh archive still hasn't been taken — rather
 * than an "off forever", so the safety-net nudge can't be silenced permanently by accident.
 */
export const ARCHIVE_NUDGE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Archive-zip layout (the single source of truth shared by {@link buildFullArchive} and
 * the restore path, so the two can never drift apart).
 */
export const ARCHIVE_DB_ENTRY = 'database/gubbins.sqlite3';
export const ARCHIVE_IMAGES_PREFIX = 'images/';
export const ARCHIVE_MANIFEST_ENTRY = 'manifest.json';

/** Marks the JSON as this archive format rather than some other file that happens to be named so. */
export const ARCHIVE_MANIFEST_KIND = 'gubbins-full-archive';

/**
 * Bumped only if the manifest's *meaning* changes. A reader does not gate on it: `baselineRevision`
 * is the load-bearing field and its meaning is fixed, so refusing to read a later manifest would
 * throw away the very check the manifest exists for.
 */
export const ARCHIVE_MANIFEST_VERSION = 1;

/**
 * What an archive says about itself (issue #501).
 *
 * Until this existed, a full archive was the one Gubbins-written container carrying no description
 * at all: a `.sqlite` and some images, with a README for the human and nothing for the app. That
 * mattered most on the restore path — the archive is the *automatic weekly* safety net for mobile
 * users without cloud sync (§2.7), so the archive being restored is often several releases old, and
 * a pre-release schema change makes such a database unopenable.
 *
 * The stamp here lets the restore refuse that **without a worker**, which is the case the
 * bytes-level check cannot cover (see `inspectRestoreCandidate`). It can therefore only *add* a
 * refusal, never grant a pass: the stamp read from the database bytes themselves is still checked
 * afterwards, so a hand-edited zip cannot talk its way through by claiming the right baseline.
 */
export interface ArchiveManifest {
  readonly kind: typeof ARCHIVE_MANIFEST_KIND;
  readonly formatVersion: number;
  /** The app version that wrote the archive. */
  readonly appVersion: string;
  /** Fingerprint of the schema baseline that built the archived database (issue #84). */
  readonly baselineRevision: string;
  /** Creation time, ISO-8601 — human-readable in a zip a user may open in a text editor. */
  readonly createdAt: string;
  /** Headline counts, so the archive is self-describing without unzipping the database. */
  readonly counts: {
    readonly images: number;
  };
}

/**
 * Whether a full archive is due: never archived, or the interval has elapsed since the
 * last one. Pure, so the weekly cadence is tested without a clock or storage.
 */
export function isArchiveDue(
  lastArchivedAt: number | null,
  now: number,
  intervalMs: number = ARCHIVE_INTERVAL_MS,
): boolean {
  if (lastArchivedAt === null) return true;
  return now - lastArchivedAt >= intervalMs;
}

/** Zip a path→bytes map in the existing fflate vault worker (reused for the archive). */
function zipInWorker(assets: Record<string, Uint8Array>, files: Record<string, string>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('@/features/export/export-vault.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<VaultZipResponse>) => {
      resolve(event.data.zip);
      worker.terminate();
    };
    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };
    const request: VaultZipRequest = { files, assets };
    worker.postMessage(request);
  });
}

/**
 * Describe an archive being written. Pure, so the manifest's shape is unit-tested without a
 * database, a worker or a clock.
 */
export function buildArchiveManifest(input: {
  readonly appVersion: string;
  readonly baselineRevision: string;
  readonly createdAt: Date;
  readonly imageCount: number;
}): ArchiveManifest {
  return {
    kind: ARCHIVE_MANIFEST_KIND,
    formatVersion: ARCHIVE_MANIFEST_VERSION,
    appVersion: input.appVersion,
    baselineRevision: input.baselineRevision,
    createdAt: input.createdAt.toISOString(),
    counts: { images: input.imageCount },
  };
}

/**
 * Build the full archive zip bytes: the raw SQLite binary under `database/` and every
 * OPFS image under `images/`, plus a `manifest.json` describing the archive and a short README.
 * Exposed for the smoke; most callers use {@link runFullArchive}.
 */
export async function buildFullArchive(): Promise<Uint8Array> {
  const sqlite = await getDatabaseDriver().exportBinary();
  const images = await readAllImages();

  const assets: Record<string, Uint8Array> = {
    [ARCHIVE_DB_ENTRY]: sqlite.slice(),
  };
  for (const img of images) assets[`${ARCHIVE_IMAGES_PREFIX}${img.name}`] = img.bytes;

  const manifest = buildArchiveManifest({
    appVersion: APP_VERSION,
    baselineRevision: BASELINE_REVISION,
    createdAt: new Date(),
    imageCount: images.length,
  });

  const files: Record<string, string> = {
    [ARCHIVE_MANIFEST_ENTRY]: JSON.stringify(manifest, null, 2),
    'README.md': [
      '# Gubbins full archive',
      '',
      'A complete offline backup created on a device without File System Access / Cloud Sync.',
      '',
      '- To restore everything (database **and** full-resolution images) on a fresh device, use Safe Mode → "Restore full archive (.zip)" and select this whole .zip.',
      '- `database/gubbins.sqlite3` — or open it directly in DB Browser for SQLite / restore via Safe Mode → "Restore raw .sqlite binary" (database only).',
      '- `images/` — the full-resolution image files referenced by the database.',
      '- `manifest.json` — which version of Gubbins wrote this archive, when, and how many images it holds.',
    ].join('\n'),
  };

  return zipInWorker(assets, files);
}

/**
 * Build and download the full archive (§2.7), returning the filename. The caller stamps
 * the "last archived" preference so the weekly prompt does not re-fire immediately.
 */
export async function runFullArchive(): Promise<string> {
  const zip = await buildFullArchive();
  const name = `gubbins-archive-${fileTimestamp()}.zip`;
  downloadBlob(name, new Blob([zip as BlobPart], { type: 'application/zip' }));
  return name;
}
