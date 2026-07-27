import { useRef, useState } from 'react';
import { Button, LiveRegion } from '@/components/foundry';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DatabaseIcon,
  DownloadIcon,
  RefreshIcon,
  ResetIcon,
  RestoreIcon,
} from '@/components/icons';
import { restoreArchive } from '@/features/archive/restore-archive';
import { createRescueBackup } from '@/features/backup/build-backup';
import { useErrorMessage } from '@/features/errors';
import {
  DamagedDatabaseError,
  downloadJsonDump,
  downloadRawSqlite,
  hardResetLocalData,
  resetServiceWorkerOnly,
  restoreRawSqlite,
} from './safe-mode-actions';

/** A restore awaiting confirmation: a raw `.sqlite` binary or a full `.zip` archive. */
type PendingRestore = { kind: 'sqlite' | 'archive'; file: File };

export interface RescueActionsProps {
  /**
   * Hide the irreversible hard reset. Set only where the failure being shown is *simulated*
   * (the lab's `schema-too-new` flag): the database is actually healthy, so offering to purge
   * it would let a presentation-only switch destroy real data on a single confirmed click. The
   * non-destructive rescues — the restorable backup, a .sqlite copy, a JSON dump, restore —
   * stay available.
   */
  readonly allowHardReset?: boolean;
  /**
   * Show *only* the two restores (and, once a file is chosen, the confirmation and damage
   * report). For the one caller whose database is not in trouble but empty: the data-loss notice
   * (issue #505), where the browser has already cleared the user's data and this fresh, healthy
   * database replaced it. There, every other action is worse than absent — a backup would
   * capture the empty database, the two diagnostic copies would hand the user a file of nothing,
   * and the reinstall and the purge both address a fault that is not the one they have. Implies
   * {@link allowHardReset} off.
   */
  readonly restoreOnly?: boolean;
}

/**
 * The shared "rescue your data" action set (spec §3) used by both the Safe Mode
 * crash fallback and the boot-failure screen. Hard reset requires a deliberate
 * second click since it is irreversible; the raw .sqlite restore (Phase 14) and the
 * full-archive restore (Phase 17 — re-hydrates OPFS images too) likewise confirm
 * before overwriting the live database.
 */
export function RescueActions({ allowHardReset = true, restoreOnly = false }: RescueActionsProps = {}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * The problems a rejected restore reported (issue #198). Non-null means the chosen file is a
   * real SQLite database but a damaged one — held in state so the user can read *what* is wrong
   * and, if they choose, override. Safe Mode must never dead-end a user whose only remaining
   * copy is an imperfect one.
   */
  const [damage, setDamage] = useState<readonly string[] | null>(null);
  /** What the rescue backup actually captured, once one has been taken (issue #197). */
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const sqliteRef = useRef<HTMLInputElement>(null);
  const archiveRef = useRef<HTMLInputElement>(null);

  /**
   * Wrap a rescue action so a failure is *shown*, not just logged. This is the last-resort
   * recovery surface: a button that silently does nothing reads as "the gentler option was
   * tried and did not help", pushing the user on to the irreversible one. `fallback` is the
   * action's own copy for when the thrown value has nothing human to say.
   */
  const run = (id: string, action: () => Promise<void>, fallback: string) => async () => {
    setBusy(id);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      // Kept for diagnostics — the user-facing sentence is the alert below.
      console.error('[gubbins] rescue action failed', error);
      setActionError(describeError(error, fallback));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Take the restorable backup (issue #197) and report what it holds. The count and the list of
   * anything missing are the point: this screen's advice ends in a purge, so the user has to be
   * able to see what they are actually carrying across *before* they take it.
   */
  const takeBackup = run(
    'backup',
    async () => {
      setBackupNote(null);
      const result = await createRescueBackup();
      const items = result.manifest.counts.items;
      const summary =
        `Saved ${result.filename} — ${items} ${items === 1 ? 'item' : 'items'}` +
        (result.manifest.counts.images > 0 ? `, ${result.manifest.counts.images} images` : '') +
        '. Restore it from Sync → Backup & restore once Gubbins starts again.';
      setBackupNote(
        result.skipped.length > 0
          ? `${summary} Some parts could not be read and are not in the file: ${result.skipped.join(', ')}.`
          : summary,
      );
    },
    'Could not build a backup.',
  );

  const onFileChosen = (kind: PendingRestore['kind']) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    setActionError(null);
    setDamage(null);
    setPending(file ? { kind, file } : null);
  };

  /**
   * Run the chosen restore. `force` re-runs one the pre-flight checks rejected, and is reachable
   * only from the second confirmation shown after those problems have been displayed.
   */
  const confirmRestore = async (force = false) => {
    if (!pending) return;
    setBusy('restore');
    setActionError(null);
    try {
      // Both reload on success. Each saves a restore point of the current database first, so a
      // restore that turns out wrong can still be undone from the downloaded copy.
      if (pending.kind === 'archive') await restoreArchive(pending.file, { force });
      else await restoreRawSqlite(pending.file, { force });
    } catch (error) {
      console.error('[gubbins] rescue action failed', error);
      if (error instanceof DamagedDatabaseError) {
        // Keep the file pending: the whole point is to offer the override on the same screen. The
        // damage panel is the `role="alert"` here, so no second copy of the same news below.
        setDamage(error.problems);
        setBusy(null);
        return;
      }
      setActionError(describeError(error, 'Restore failed.'));
      setBusy(null);
      setPending(null);
      setDamage(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {restoreOnly ? null : (
        <>
          {/*
           * The restorable rescue (issue #197), first and solid because it is the only one of these
           * downloads the app can read back in. The two below it are diagnostic copies: after the
           * hard reset this screen recommends, a `.sqlite` from the old schema is refused by the
           * restore guard and the JSON dump has no importer at all — so leading with either would
           * send the user into a purge holding a file that cannot bring their data back.
           */}
          <Button variant="primary" onClick={takeBackup} disabled={busy !== null}>
            <ArchiveIcon /> Back up everything (.zip)
          </Button>
          <p className="text-xs text-muted-foreground">
            The copy to take before resetting: restore it afterwards from Sync → Backup &amp; restore, using{' '}
            <span className="font-medium">Merge</span>, which brings your records across a schema change.
          </p>
          {/*
           * Always mounted, contents swapped: a live region inserted at the moment its message
           * appears is frequently never announced. What the backup captured — and anything it had
           * to leave out — is precisely what a screen-reader user must hear before the reset.
           */}
          <LiveRegion>
            {backupNote ? <p className="text-sm text-foreground">{backupNote}</p> : null}
          </LiveRegion>

          <Button
            variant="outline"
            onClick={run('sqlite', downloadRawSqlite, 'Could not download the database file.')}
            disabled={busy !== null}
          >
            <DatabaseIcon /> Download raw .sqlite binary
          </Button>
          <Button
            variant="outline"
            onClick={run('json', downloadJsonDump, 'Could not export your data.')}
            disabled={busy !== null}
          >
            <DownloadIcon /> Export data (JSON)
          </Button>
          <p className="text-xs text-muted-foreground">
            Those two are copies to keep or inspect elsewhere — a database file for a SQLite browser, and a
            plain data dump. Neither can be restored into Gubbins after a reset.
          </p>
        </>
      )}

      <input
        ref={sqliteRef}
        type="file"
        accept=".sqlite,.sqlite3,.db,application/x-sqlite3"
        className="hidden"
        data-testid="restore-sqlite-input"
        onChange={onFileChosen('sqlite')}
      />
      <input
        ref={archiveRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        data-testid="restore-archive-input"
        onChange={onFileChosen('archive')}
      />
      {pending ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-sm">
          <p>
            {pending.kind === 'archive' ? 'Restore the full archive ' : 'Replace the live database with '}
            <span className="font-medium">{pending.file.name}</span>?
            {pending.kind === 'archive'
              ? ' This overwrites all local data and re-imports the full-resolution images.'
              : ' This overwrites all local data.'}{' '}
            <strong>A copy of your current database is downloaded first</strong> so this can be undone.
          </p>
          {/*
           * The damage report (issue #198). Shown only after the checks have rejected the file,
           * and it replaces the ordinary confirm button with an explicit "restore anyway" — the
           * user has to read what is wrong before they can act on it.
           */}
          {damage ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <p className="font-medium">This database file is damaged — nothing has been changed:</p>
              <ul className="mt-1 list-disc ps-5">
                {/* Indexed keys: integrity_check happily reports the same message twice. */}
                {damage.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
              <p className="mt-1">
                Restoring it anyway may lose records, though SQLite can often still read most of a damaged
                database. Your current one is saved as a restore point either way.
              </p>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              className="flex-1"
              data-testid="confirm-archive-restore"
              onClick={() => void confirmRestore(damage !== null)}
              disabled={busy !== null}
            >
              <RestoreIcon />{' '}
              {damage ? 'Restore anyway — this may lose records' : 'Confirm — restore & reload'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setDamage(null);
              }}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button variant="outline" onClick={() => sqliteRef.current?.click()} disabled={busy !== null}>
            <RestoreIcon /> Restore raw .sqlite binary
          </Button>
          <Button variant="outline" onClick={() => archiveRef.current?.click()} disabled={busy !== null}>
            <ArchiveRestoreIcon /> Restore full archive (.zip)
          </Button>
        </>
      )}
      {/*
       * The data-preserving escape hatch (issue #276), deliberately above the hard reset: when
       * the *build* is what broke — a bad deploy the cache-first worker keeps serving — this
       * fixes it without costing the user their inventory. Offering it first means the
       * irreversible purge is the last resort it is meant to be, not the only worker reset
       * on the menu.
       *
       * Left untranslated like every other string here, deliberately: `AppErrorBoundary` is the
       * outermost wrapper in `App.tsx`, so this renders after the app below it has already
       * failed. Its copy stays literal rather than depending on the i18n catalog being in a
       * state to answer. (The same action in Settings — where the app is healthy — does go
       * through `t()`.)
       */}
      {restoreOnly ? null : (
        <Button
          variant="outline"
          onClick={run('sw-reset', resetServiceWorkerOnly, 'Could not clear the cached app files.')}
          disabled={busy !== null}
        >
          <RefreshIcon /> Reinstall app files (keeps your data)
        </Button>
      )}

      {/*
       * Above the hard reset, deliberately: this is the failure the user must read *before*
       * the irreversible option, not after it. Rendering it below would put the explanation
       * for "the gentle rescue failed" underneath the destructive button it should steer
       * them away from.
       */}
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {restoreOnly || !allowHardReset ? null : confirmingReset ? (
        <div className="flex gap-2">
          <Button
            variant="destructive"
            className="flex-1"
            onClick={run('reset', hardResetLocalData, 'Could not purge local data.')}
            disabled={busy !== null}
          >
            <ResetIcon /> Confirm — purge &amp; reload
          </Button>
          <Button variant="ghost" onClick={() => setConfirmingReset(false)} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          className="text-destructive hover:bg-destructive/10"
          onClick={() => setConfirmingReset(true)}
          disabled={busy !== null}
        >
          <ResetIcon /> Hard reset &amp; purge local data
        </Button>
      )}
    </div>
  );
}
