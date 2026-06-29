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
import { readAllImages } from '@/features/images/opfs-images';
import { downloadBlob, fileTimestamp } from '@/lib/download';
import type { VaultZipRequest, VaultZipResponse } from '@/features/export/export-vault.worker';

/** Weekly cadence (§2.7 "weekly prompt"). */
export const ARCHIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Archive-zip layout (the single source of truth shared by {@link buildFullArchive} and
 * the restore path, so the two can never drift apart).
 */
export const ARCHIVE_DB_ENTRY = 'database/gubbins.sqlite3';
export const ARCHIVE_IMAGES_PREFIX = 'images/';

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
    const worker = new Worker(
      new URL('@/features/export/export-vault.worker.ts', import.meta.url),
      { type: 'module' },
    );
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
 * Build the full archive zip bytes: the raw SQLite binary under `database/` and every
 * OPFS image under `images/`, plus a short README. Exposed for the smoke; most callers
 * use {@link runFullArchive}.
 */
export async function buildFullArchive(): Promise<Uint8Array> {
  const sqlite = await getDatabaseDriver().exportBinary();
  const images = await readAllImages();

  const assets: Record<string, Uint8Array> = {
    [ARCHIVE_DB_ENTRY]: sqlite.slice(),
  };
  for (const img of images) assets[`${ARCHIVE_IMAGES_PREFIX}${img.name}`] = img.bytes;

  const files: Record<string, string> = {
    'README.md': [
      '# Gubbins full archive',
      '',
      'A complete offline backup created on a device without File System Access / Cloud Sync.',
      '',
      '- To restore everything (database **and** full-resolution images) on a fresh device, use Safe Mode → "Restore full archive (.zip)" and select this whole .zip.',
      '- `database/gubbins.sqlite3` — or open it directly in DB Browser for SQLite / restore via Safe Mode → "Restore raw .sqlite binary" (database only).',
      '- `images/` — the full-resolution image files referenced by the database.',
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
