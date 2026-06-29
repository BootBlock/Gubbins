/**
 * Backup restore (browser glue for "Backup & Restore" → Restore).
 *
 * Reads a chosen backup file into the pure {@link ParsedBackup} (validated + version-guarded
 * by the codec) and applies it in one of two modes the user picks per restore:
 *
 *  - **merge** — non-destructive: UPSERT every record from the backup over the current data
 *    (re-creating anything deleted since, keeping records the backup doesn't carry). Uses the
 *    portable snapshot via {@link restoreSnapshot}.
 *  - **replace** — a true point-in-time restore: make the device match the backup exactly.
 *    Prefers the exact `.sqlite` copy when present (overwrite OPFS, like the archive restore);
 *    otherwise wipes and clones from the portable snapshot.
 *
 * Either way the full-resolution images are re-hydrated into OPFS and the settings restored.
 * The app only needs to **reload** when the worker was disposed (an exact `.sqlite` replace) or
 * when settings were written (the Zustand stores re-hydrate at boot); a plain data merge takes
 * effect through a query invalidation with no reload. {@link restoreBackup} reports which is
 * needed so the caller can either reload (carrying a one-off notice via
 * {@link consumeRestoreNotice}) or refresh in place.
 */
import { getDatabaseDriver, disposeDatabase } from '@/db/client';
import {
  buildCloneStatements,
  buildSchemaDictionary,
  restoreSnapshot,
  SYNC_TABLES,
} from '@/features/sync/snapshot';
import { ITEM_HISTORY_TABLE } from '@/db/repositories';
import { overwriteOpfsDatabase } from '@/app/error/safe-mode-actions';
import { writeImageFiles } from '@/features/images/opfs-images';
import { readBackupFile, type ParsedBackup } from './backup-format';
import { applySettings } from './backup-settings';

export type RestoreMode = 'merge' | 'replace';

/** Read a chosen file's bytes and decode it into a {@link ParsedBackup} (for preview + restore). */
export async function readBackup(file: File): Promise<ParsedBackup> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readBackupFile(bytes);
}

const RESTORE_NOTICE_KEY = 'gubbins:backup-restored';

/** Record a one-off success message to show after a post-restore reload. */
export function rememberRestoreNotice(message: string): void {
  try {
    sessionStorage.setItem(RESTORE_NOTICE_KEY, message);
  } catch {
    // sessionStorage unavailable — the restore still succeeds; we just skip the notice.
  }
}

/** Read-and-clear the post-restore success message (the Sync screen shows it on mount). */
export function consumeRestoreNotice(): string | null {
  try {
    const message = sessionStorage.getItem(RESTORE_NOTICE_KEY);
    if (message) sessionStorage.removeItem(RESTORE_NOTICE_KEY);
    return message;
  } catch {
    return null;
  }
}

/** What the caller must do after a restore to surface the new state. */
export interface RestoreOutcome {
  /** True when the app must reload (worker disposed, or settings re-hydrate at boot). */
  readonly reloadRequired: boolean;
  /** A short human summary of what was restored. */
  readonly message: string;
}

/**
 * Apply a parsed backup in the chosen mode. **Destructive in `replace` mode** — the caller
 * must confirm first. Does not reload; returns whether a reload is required (see
 * {@link RestoreOutcome}) so the caller reloads or invalidates queries in place.
 */
export async function restoreBackup(parsed: ParsedBackup, mode: RestoreMode): Promise<RestoreOutcome> {
  let reloadRequired = false;
  if (mode === 'replace') {
    reloadRequired = await restoreReplace(parsed);
  } else {
    await restoreMerge(parsed);
  }

  const settingsRestored = parsed.settings ? applySettings(parsed.settings) : 0;
  if (settingsRestored > 0) reloadRequired = true; // stores only re-hydrate on boot

  return { reloadRequired, message: restoreSummary(parsed, mode, settingsRestored) };
}

/** Non-destructive UPSERT from the portable snapshot, then re-hydrate images. */
async function restoreMerge(parsed: ParsedBackup): Promise<void> {
  const driver = getDatabaseDriver();
  await restoreSnapshot(driver, parsed.snapshot);
  if (parsed.images.length > 0) await writeImageFiles(parsed.images);
}

/**
 * Exact point-in-time restore. With an embedded `.sqlite` copy, dispose the worker and
 * overwrite the OPFS database verbatim (then re-hydrate images) — a reload is then required.
 * Without it, wipe-and-clone the portable snapshot in one transaction through the live worker
 * (no reload needed). Returns whether the worker was disposed.
 */
async function restoreReplace(parsed: ParsedBackup): Promise<boolean> {
  if (parsed.sqlite) {
    await disposeDatabase();
    await overwriteOpfsDatabase(parsed.sqlite);
    if (parsed.images.length > 0) await writeImageFiles(parsed.images);
    return true;
  }

  const driver = getDatabaseDriver();
  const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
  await driver.transaction(buildCloneStatements(parsed.snapshot, dictionary));
  if (parsed.images.length > 0) await writeImageFiles(parsed.images);
  return false;
}

/** A short human summary of what was restored, shown once after the reload. */
function restoreSummary(parsed: ParsedBackup, mode: RestoreMode, settingsRestored: number): string {
  const verb = mode === 'replace' ? 'Replaced from' : 'Merged in';
  const parts = [`${parsed.snapshot.tables.items?.length ?? 0} items`];
  if (parsed.images.length > 0) parts.push(`${parsed.images.length} images`);
  if (settingsRestored > 0) parts.push('settings');
  return `${verb} backup — ${parts.join(', ')}.`;
}
