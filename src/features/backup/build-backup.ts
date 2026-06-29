/**
 * Backup builder (browser glue for "Backup & Restore" → Create).
 *
 * Gathers the live pieces — the portable {@link SyncSnapshot}, an optional exact `.sqlite`
 * copy, the OPFS full-resolution images, and the device settings — shapes them through the
 * pure {@link assembleBackup} codec, zips off-thread in the shared fflate worker, and triggers
 * the download. All format decisions live in `backup-format.ts`; this file only does IO.
 */
import { getDatabaseDriver } from '@/db/client';
import { buildLocalSnapshot } from '@/features/sync/snapshot';
import { readAllImages } from '@/features/images/opfs-images';
import { downloadBlob, fileTimestamp } from '@/lib/download';
import { APP_VERSION } from '@/lib/app-version';
import type { VaultZipRequest, VaultZipResponse } from '@/features/export/export-vault.worker';
import {
  assembleBackup,
  filterSnapshot,
  type BackupManifest,
  type BackupSelection,
} from './backup-format';
import { collectSettings } from './backup-settings';

/** The outcome of a successful backup, for the success summary in the dialog. */
export interface BackupResult {
  readonly filename: string;
  /** Size of the downloaded zip in bytes. */
  readonly size: number;
  readonly manifest: BackupManifest;
}

/** Options for {@link createBackup} — currently just the download filename prefix. */
export interface CreateBackupOptions {
  /** Filename stem, e.g. `gubbins-restore-point` for a pre-restore safety copy. */
  readonly filenamePrefix?: string;
}

/**
 * Build and download a complete backup for the chosen {@link BackupSelection}. The portable
 * snapshot is always included; the toggles add the exact `.sqlite` copy, full-resolution
 * images and settings, and shape the snapshot's history / removed-items content.
 */
export async function createBackup(
  selection: BackupSelection,
  options: CreateBackupOptions = {},
): Promise<BackupResult> {
  const driver = getDatabaseDriver();

  const full = await buildLocalSnapshot(driver);
  const snapshot = filterSnapshot(full, {
    includeHistory: selection.history,
    includeRemovedItems: selection.removedItems,
  });

  // Copy the sqlite bytes out of WASM memory so the Blob is independent of the worker heap.
  const sqlite = selection.rawSqlite ? (await driver.exportBinary()).slice() : null;
  const images = selection.images ? await readAllImages() : [];
  const settings = selection.settings ? collectSettings() : null;

  const { files, assets, manifest } = assembleBackup({
    snapshot,
    sqlite,
    images,
    settings,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
  });

  const zip = await zipInWorker(files, assets);
  const filename = `${options.filenamePrefix ?? 'gubbins-backup'}-${fileTimestamp()}.zip`;
  downloadBlob(filename, new Blob([zip as BlobPart], { type: 'application/zip' }));
  return { filename, size: zip.byteLength, manifest };
}

/** Zip a text + binary entry map in the shared fflate worker (off the main thread). */
function zipInWorker(
  files: Record<string, string>,
  assets: Record<string, Uint8Array>,
): Promise<Uint8Array> {
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
