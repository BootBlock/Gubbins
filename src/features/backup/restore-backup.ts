/**
 * Backup restore (browser glue for "Backup & Restore" → Restore).
 *
 * Reads a chosen backup file into the pure {@link ParsedBackup} (validated + version-guarded
 * by the codec) and applies it in one of two modes the user picks per restore:
 *
 *  - **merge** — non-destructive: UPSERT every record from the backup over the current data
 *    (re-creating anything deleted since, keeping records the backup doesn't carry, and never
 *    removing a live record because the backup considered it deleted). Uses the portable
 *    snapshot via {@link restoreSnapshot}.
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
 *
 * The images are re-hydrated *after* the data has committed, so they can never fail the restore
 * (issue #639): whatever could not be written is counted into {@link RestoreOutcome.imagesMissed}
 * and reported as a partial success. Past the commit there is nothing to unwind — the backup's
 * data is already the data on this device, and saying otherwise sends the user looking for
 * records that are no longer anywhere else.
 */
import { getDatabaseDriver } from '@/db/client';
import {
  buildCloneStatements,
  buildSchemaDictionary,
  restoreSnapshot,
  withCaptureDisabled,
  SYNC_TABLES,
} from '@/features/sync/snapshot';
import { ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE } from '@/db/repositories';
import { overwriteDatabaseFile, StaleJournalError } from '@/app/error/safe-mode-actions';
import { writeImageFiles } from '@/features/images/opfs-images';
import { BASELINE_REVISION } from '@/db/migrations';
import { plural } from '@/lib/plural';
import { narrowSnapshotSettings, readBackupFile, type ParsedBackup } from './backup-format';
import { applySettings } from './backup-settings';
import { DEFAULT_SETTINGS_GROUPS, type SettingsGroupSelection } from './settings-groups';

export type RestoreMode = 'merge' | 'replace';

/** Read a chosen file's bytes and decode it into a {@link ParsedBackup} (for preview + restore). */
export async function readBackup(file: File): Promise<ParsedBackup> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readBackupFile(bytes);
}

const RESTORE_NOTICE_KEY = 'gubbins:backup-restored';

/**
 * How loudly a restore's outcome should be said: `warning` when it landed but left something
 * out — a partial success is not news to deliver in the same voice as a clean one (issue #639).
 */
export type RestoreNoticeTone = 'info' | 'warning';

/** The one-off message shown after a restore, and how loudly to say it. */
export interface RestoreNotice {
  readonly message: string;
  readonly tone: RestoreNoticeTone;
}

/** Record a one-off outcome message to show after a post-restore reload. */
export function rememberRestoreNotice(notice: RestoreNotice): void {
  try {
    sessionStorage.setItem(RESTORE_NOTICE_KEY, JSON.stringify(notice));
  } catch {
    // sessionStorage unavailable — the restore still succeeds; we just skip the notice.
  }
}

/** Read-and-clear the post-restore outcome message (the Sync screen shows it on mount). */
export function consumeRestoreNotice(): RestoreNotice | null {
  try {
    const raw = sessionStorage.getItem(RESTORE_NOTICE_KEY);
    if (!raw) return null;
    // Cleared before it is decoded: a notice that cannot be read is still a notice that has
    // been delivered as far as it ever will be, and leaving it would re-run this every mount.
    sessionStorage.removeItem(RESTORE_NOTICE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { message, tone } = parsed as Record<string, unknown>;
    if (typeof message !== 'string' || message.length === 0) return null;
    return { message, tone: tone === 'warning' ? 'warning' : 'info' };
  } catch {
    return null;
  }
}

/** What the caller must do after a restore to surface the new state. */
export interface RestoreOutcome {
  /** True when the app must reload (worker disposed, or settings re-hydrate at boot). */
  readonly reloadRequired: boolean;
  /**
   * How many of the backup's full-resolution images could not be written back to this device
   * (issue #639). Non-zero makes this a **partial** success, never a failure: the data itself
   * has already committed, so the caller still reloads or invalidates — it just says so.
   */
  readonly imagesMissed: number;
  /** A short human summary of what was restored. */
  readonly message: string;
}

/**
 * Apply a parsed backup in the chosen mode. **Destructive in `replace` mode** — the caller
 * must confirm first. Does not reload; returns whether a reload is required (see
 * {@link RestoreOutcome}) so the caller reloads or invalidates queries in place.
 *
 * `settingGroups` narrows which of the settings the backup carries actually land on this device
 * (issue #175); the groups not chosen keep whatever this device already had, because the
 * preferences blob is merged rather than overwritten.
 */
export async function restoreBackup(
  parsed: ParsedBackup,
  mode: RestoreMode,
  settingGroups: SettingsGroupSelection = DEFAULT_SETTINGS_GROUPS,
): Promise<RestoreOutcome> {
  // Issue #382: the picker has to narrow the *shared* copy of the settings as well as the
  // device-local one below, or on a device that shares settings live the unticked groups would land
  // in the `settings` table anyway and be adopted into those preferences by the next sync.
  const narrowed: ParsedBackup = {
    ...parsed,
    snapshot: narrowSnapshotSettings(parsed.snapshot, settingGroups),
  };

  let reloadRequired = false;
  let imagesMissed = 0;
  if (mode === 'replace') {
    ({ reloadRequired, imagesMissed } = await restoreReplace(narrowed));
  } else {
    imagesMissed = await restoreMerge(narrowed);
  }

  const settingsRestored = parsed.settings ? applySettings(parsed.settings, settingGroups) : 0;
  if (settingsRestored > 0) reloadRequired = true; // stores only re-hydrate on boot

  return {
    reloadRequired,
    imagesMissed,
    message: restoreSummary(parsed, mode, settingsRestored, imagesMissed),
  };
}

/** Non-destructive UPSERT from the portable snapshot, then re-hydrate images. */
async function restoreMerge(parsed: ParsedBackup): Promise<number> {
  const driver = getDatabaseDriver();
  await restoreSnapshot(driver, parsed.snapshot);
  return await rehydrateImages(parsed);
}

/** What {@link restoreReplace} did: whether the worker went, and what the images cost. */
interface ReplaceResult {
  readonly reloadRequired: boolean;
  readonly imagesMissed: number;
}

/**
 * Write the backup's full-resolution images beside data that has *already* committed, and
 * report how many could not be written (issue #639).
 *
 * Every call site is past the point of no return, so this never throws: a re-hydration that
 * falls short is a restore that happened minus some images, and unwinding it would tell the
 * user their data is where they left it when it is not. The cause is logged for diagnostics,
 * because the number is all the sentence the user gets.
 */
async function rehydrateImages(parsed: ParsedBackup): Promise<number> {
  if (parsed.images.length === 0) return 0;
  const report = await writeImageFiles(parsed.images);
  if (report.failed.length > 0) {
    console.warn(
      `[gubbins] restore: ${report.failed.length} of ${parsed.images.length} images could not be written`,
      report.failure,
    );
  }
  return report.failed.length;
}

/**
 * Exact point-in-time restore. With an embedded `.sqlite` copy, replace the stored database
 * verbatim (then re-hydrate images) — that releases the worker, so a reload is required.
 * Without it, wipe-and-clone the portable snapshot in one transaction through the live worker
 * (no reload needed). Returns whether the worker was disposed, and what the images cost.
 */
async function restoreReplace(parsed: ParsedBackup): Promise<ReplaceResult> {
  if (parsed.sqlite) {
    // Refuse an exact-copy restore from an incompatible schema *before* touching OPFS. Gubbins
    // is pre-release and does not migrate across baseline changes, so such a database would be
    // refused at the next boot (SCHEMA_STALE) — but by then the current data is already gone.
    // Backups written before the manifest carried a stamp can't be checked, so they proceed as
    // before rather than being blocked on a missing field. A manifest that is *present but
    // unreadable* is not that case: it is damage, and letting it through would mean corruption
    // silently buys a pass through the very check that protects the live database (issue #353).
    if (parsed.manifestUnreadable) {
      throw new Error(
        'This backup’s description file is damaged, so Gubbins cannot confirm its exact database ' +
          'copy works with this build. Restore it with the “merge” mode instead, which brings your ' +
          'records across without replacing the database file.',
      );
    }
    const stamp = parsed.manifest?.baselineRevision;
    if (stamp && stamp !== BASELINE_REVISION) {
      throw new Error(
        'This backup was made with a different version of Gubbins, and its exact database copy ' +
          'is not compatible with this build. Restore it with the “merge” mode instead, which ' +
          'brings your records across without replacing the database file.',
      );
    }
    // A `StaleJournalError` lands *after* the new bytes commit, so the images still belong
    // beside them — write them, then let the failure through so the caller reports it rather
    // than reloading into a journal replay (#203).
    let staleJournal: StaleJournalError | undefined;
    try {
      await overwriteDatabaseFile(parsed.sqlite);
    } catch (error) {
      if (!(error instanceof StaleJournalError)) throw error;
      staleJournal = error;
    }
    const imagesMissed = await rehydrateImages(parsed);
    // A stale journal outranks a shortfall of images: it is the one thing here that must be
    // read and acted on *before* the app is reloaded at all, and burying that single
    // instruction under a lesser one would risk the restored database being rolled back.
    if (staleJournal) throw staleJournal;
    return { reloadRequired: true, imagesMissed };
  }

  const driver = getDatabaseDriver();
  const dictionary = await buildSchemaDictionary(driver, [
    ...SYNC_TABLES,
    ITEM_HISTORY_TABLE,
    STOCK_DELTAS_TABLE,
  ]);
  // Issue #188: the clone re-inserts stock rows whose deltas travel in the unioned ledger, so the
  // whole batch runs capture-disabled (buildCloneStatements is now a plain, unguarded builder).
  await driver.transaction(withCaptureDisabled(buildCloneStatements(parsed.snapshot, dictionary)));
  const imagesMissed = await rehydrateImages(parsed);
  return { reloadRequired: false, imagesMissed };
}

/** A short human summary of what was restored, shown once after the reload. */
function restoreSummary(
  parsed: ParsedBackup,
  mode: RestoreMode,
  settingsRestored: number,
  imagesMissed: number,
): string {
  const verb = mode === 'replace' ? 'Replaced from' : 'Merged in';
  const items = parsed.snapshot.tables.items?.length ?? 0;
  const parts = [`${items} ${plural(items, 'item')}`];
  const images = parsed.images.length;
  if (images > 0) parts.push(`${images} ${plural(images, 'image')}`);
  if (settingsRestored > 0) parts.push('settings');
  const summary = `${verb} backup — ${parts.join(', ')}.`;
  if (imagesMissed === 0) return summary;
  // Says what is missing and what is not, because the alternative reading — that the whole
  // restore came apart — is the one the user will otherwise reach for (issue #639).
  return (
    `${summary} ${imagesMissed} ${plural(imagesMissed, 'image')} could not be saved to this device, ` +
    'which may be out of storage — everything else was restored.'
  );
}
