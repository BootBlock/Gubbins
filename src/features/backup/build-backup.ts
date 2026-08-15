/**
 * Backup builder (browser glue for "Backup & Restore" → Create).
 *
 * Gathers the live pieces — the portable {@link SyncSnapshot}, an optional exact `.sqlite`
 * copy, the OPFS full-resolution images, and the device settings — shapes them through the
 * pure {@link assembleBackup} codec, zips off-thread in the shared fflate worker, and triggers
 * the download. All format decisions live in `backup-format.ts`; this file only does IO.
 */
import { getDatabaseDriver, getRescueDatabaseDriver } from '@/db/client';
import { buildLocalSnapshot } from '@/features/sync/snapshot';
import { readAllImages } from '@/features/images/opfs-images';
import { downloadBlob, fileTimestamp } from '@/lib/download';
import { saveBeforeDestroying, type SafeSave, type SaveFileKind } from '@/lib/save-file';
import { APP_VERSION } from '@/lib/app-version';
import { zipInVaultWorker } from '@/features/export/zip-in-worker';
import { BASELINE_REVISION, BASELINE_REVISION_KEY } from '@/db/migrations';
import {
  assembleBackup,
  DEFAULT_BACKUP_SELECTION,
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
  /**
   * Parts of the database that could not be read and are therefore **absent** from the file
   * (issue #197). Always empty for an ordinary backup, which fails outright rather than
   * dropping anything; only a `rescue` backup can come back partial, and when it does the
   * caller must say so rather than report plain success.
   */
  readonly skipped: readonly string[];
  /**
   * True only when this backup is **known** to have reached the user, and therefore safe to
   * destroy the original on the strength of (issue #502). Requires a {@link CreateBackupOptions.save};
   * an ordinary download is never `secured`, because an `<a download>` cannot report back — that
   * is not a failure for the Create tab, which is not about to delete anything.
   */
  readonly secured: boolean;
}

/** How a backup is offered in a save picker. */
export const BACKUP_FILE_KIND: SaveFileKind = {
  description: 'Gubbins backup',
  mimeType: 'application/zip',
  extensions: ['.zip'],
};

/**
 * The name a backup takes, needed up front by a caller reserving its destination before the
 * zip exists (issue #502).
 */
export function backupFilename(prefix = 'gubbins-backup'): string {
  return `${prefix}-${fileTimestamp()}.zip`;
}

/** Options for {@link createBackup}. */
export interface CreateBackupOptions {
  /** Filename stem, e.g. `gubbins-restore-point` for a pre-restore safety copy. */
  readonly filenamePrefix?: string;
  /**
   * Save through a destination reserved by the caller, and report in {@link BackupResult.secured}
   * whether the file provably landed (issue #502). Set by a caller that is about to destroy what
   * this backup copies; omitted, the zip is handed to the browser's downloads and nothing is
   * claimed about where it went. Takes precedence over {@link filenamePrefix}, since the
   * destination was named when it was reserved.
   */
  readonly save?: SafeSave;
  /**
   * Build the backup from a database this build cannot open normally (issue #197).
   *
   * Set only by the boot-failure rescue, where a schema mismatch means tables this build knows
   * about may be missing from the file on disk. It takes every part that reads successfully and
   * records the rest in {@link BackupResult.skipped}, and it stamps the manifest with the
   * baseline the database *actually* carries rather than this build's — so a later Replace
   * restore still correctly refuses the embedded database copy instead of re-creating the very
   * boot failure the user is escaping.
   */
  readonly rescue?: boolean;
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
  const rescue = options.rescue === true;
  // A rescue runs on the crash screen, where a dead worker latches the driver unusable and every
  // read would be rejected without one being replaced first (issue #503). An ordinary backup runs
  // in a healthy app and must not quietly rebuild the worker under a live session.
  const driver = rescue ? await getRescueDatabaseDriver() : getDatabaseDriver();
  const skipped: string[] = [];

  /** In rescue mode, an optional extra that fails is recorded and dropped, not fatal. */
  const optional = async <T>(part: string, read: () => Promise<T>, empty: T): Promise<T> => {
    if (!rescue) return read();
    try {
      return await read();
    } catch (error) {
      console.error(`[gubbins] rescue backup could not include ${part}`, error);
      skipped.push(part);
      return empty;
    }
  };

  const full = await buildLocalSnapshot(driver, Date.now(), {
    skipUnreadable: rescue,
    onSkipped: (part) => skipped.push(part),
  });
  const snapshot = filterSnapshot(full, {
    includeHistory: selection.history,
    includeRemovedItems: selection.removedItems,
    includeSettings: selection.settings,
    settingGroups: selection.settingGroups,
  });

  // Copy the sqlite bytes out of WASM memory so the Blob is independent of the worker heap.
  const sqlite = selection.rawSqlite
    ? await optional('the exact database copy', async () => (await driver.exportBinary()).slice(), null)
    : null;
  const images = selection.images ? await optional('images', () => readAllImages(), []) : [];
  // Only the setting groups the user ticked travel; an all-unticked selection yields an empty
  // record, which is treated as "no settings" so the backup carries no `settings.json` at all.
  const collected = selection.settings ? collectSettings(selection.settingGroups) : null;
  const settings = collected && Object.keys(collected).length > 0 ? collected : null;

  const { files, assets, manifest } = assembleBackup({
    snapshot,
    sqlite,
    images,
    settings,
    appVersion: APP_VERSION,
    // Stamp the schema baseline this database was built from, so a later `replace` restore can
    // refuse an incompatible backup before it overwrites anything (issue #84).
    baselineRevision: rescue ? await readBaselineStamp(driver) : BASELINE_REVISION,
    createdAt: Date.now(),
  });

  const zip = await zipInVaultWorker(files, assets);
  const blob = new Blob([zip as BlobPart], { type: 'application/zip' });
  const filename = options.save?.saver.filename ?? backupFilename(options.filenamePrefix);
  let secured = false;
  if (options.save) {
    secured = await saveBeforeDestroying(blob, options.save);
  } else {
    downloadBlob(filename, blob);
  }
  return { filename, size: zip.byteLength, manifest, skipped, secured };
}

/**
 * The baseline fingerprint the **database on disk** carries, for a rescue backup's manifest
 * (issue #197).
 *
 * Never falls back to this build's `BASELINE_REVISION`: the whole reason a rescue backup exists
 * is that the database was built by a different revision, so claiming otherwise would let a
 * later Replace restore write an incompatible database back and reproduce the boot failure. An
 * unreadable stamp therefore reports a value that cannot match any real fingerprint, which is
 * exactly how the restore guard is meant to read "not from this build".
 */
async function readBaselineStamp(driver: ReturnType<typeof getDatabaseDriver>): Promise<string> {
  try {
    const row = await driver.queryOne<{ value: string | null }>('SELECT value FROM app_meta WHERE key = ?;', [
      BASELINE_REVISION_KEY,
    ]);
    return row?.value ?? UNKNOWN_BASELINE_REVISION;
  } catch {
    // No `app_meta` at all — a database older than the stamp itself. Unknown, not current.
    return UNKNOWN_BASELINE_REVISION;
  }
}

/** Manifest stamp for a database whose own baseline fingerprint could not be read. */
const UNKNOWN_BASELINE_REVISION = 'unknown';

/**
 * Build the restorable backup offered by the crash and boot-failure screens (issue #197).
 *
 * Those screens used to hand out only an exact `.sqlite` copy and a raw JSON dump — neither of
 * which anything can restore once the user takes the reset the same screen recommends. This
 * produces the ordinary, fully supported backup instead, so "back up, then reset" ends with the
 * data actually coming back (through Restore's **merge** mode, which re-applies the portable
 * snapshot column by column and so survives the schema change that caused the failure).
 *
 * Everything the database will give up is included, and anything it will not is reported in
 * {@link BackupResult.skipped} rather than failing the whole file.
 */
export function createRescueBackup(): Promise<BackupResult> {
  return createBackup(DEFAULT_BACKUP_SELECTION, {
    filenamePrefix: 'gubbins-rescue-backup',
    rescue: true,
  });
}
