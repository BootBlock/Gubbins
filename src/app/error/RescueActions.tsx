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
import { assertExhaustive } from '@/lib/exhaustive';
import { prepareSave } from '@/lib/save-file';
import { useConfirmSaved } from '@/components/useConfirmSaved';
import {
  DamagedDatabaseError,
  downloadJsonDump,
  downloadRawSqlite,
  hardResetLocalData,
  IncompatibleDatabaseError,
  resetServiceWorkerOnly,
  restorePointFilename,
  RestorePointNotSavedError,
  restoreRawSqlite,
  SQLITE_FILE_KIND,
} from './safe-mode-actions';

/** A restore awaiting confirmation: a raw `.sqlite` binary or a full `.zip` archive. */
type PendingRestore = { kind: 'sqlite' | 'archive'; file: File };

/**
 * Why a restore was refused, held so the user can read it and — if they still choose to —
 * override. `damaged` carries what `integrity_check` said; `incompatible` has nothing to list,
 * because a schema fingerprint means nothing to a reader (issue #501).
 */
type RestoreRefusal =
  { readonly kind: 'damaged'; readonly problems: readonly string[] } | { readonly kind: 'incompatible' };

/**
 * The confirm button's wording — it must name the risk the user is accepting, which differs per
 * refusal. Guarded so a third refusal kind cannot quietly inherit "this may lose records".
 */
function confirmRestoreLabel(refusal: RestoreRefusal | null): string {
  if (refusal === null) return 'Confirm — restore & reload';
  switch (refusal.kind) {
    case 'damaged':
      return 'Restore anyway — this may lose records';
    case 'incompatible':
      return 'Restore anyway — Gubbins may not start';
    default:
      assertExhaustive(refusal);
      return 'Restore anyway';
  }
}

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
   * Show *only* the two restores (and, once a file is chosen, the confirmation and whichever
   * refusal applies). For the one caller whose database is not in trouble but empty: the data-loss notice
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
   * Why the pre-flight refused the chosen file (issues #198, #501). Non-null means it is a real
   * SQLite database that Gubbins will not restore as-is — damaged, or built by a schema this build
   * cannot open — held in state so the user can read *why* and, if they choose, override. Safe
   * Mode must never dead-end a user whose only remaining copy is an imperfect one.
   */
  const [refusal, setRefusal] = useState<RestoreRefusal | null>(null);
  /** What the rescue backup actually captured, once one has been taken (issue #197). */
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const describeError = useErrorMessage();
  // The restore point's fallback proof-of-save, where the browser cannot give one (issue #502).
  const { confirmSaved, confirmSavedDialog } = useConfirmSaved();
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
    setRefusal(null);
    setPending(file ? { kind, file } : null);
  };

  /**
   * Run the chosen restore. `force` re-runs one the pre-flight checks rejected, and is reachable
   * only from the second confirmation shown after the reason has been displayed.
   */
  const confirmRestore = async (force = false) => {
    if (!pending) return;
    setBusy('restore');
    setActionError(null);
    // Reserved here, inside the click (issue #502): the restore point is the undo for an
    // irreversible overwrite, and the picker that can confirm it actually saved needs the user
    // gesture — which the integrity checks below outlast comfortably.
    //
    // So a file the pre-flight goes on to reject costs a destination pick that is never written
    // to. `prepareDestructiveRestore` orders its checks first precisely to spare a rejected file
    // that cost, and it still does for the part that matters — nothing is *copied* until the
    // file has passed. Naming a destination is the cheap half, and it is the half that has to
    // happen while the click is still warm.
    const saver = await prepareSave(restorePointFilename(), SQLITE_FILE_KIND);
    if (!saver) {
      // The user closed the save dialog. Keep the file pending so they can try again.
      setBusy(null);
      return;
    }
    const save = { saver, confirmUnverified: confirmSaved };
    try {
      // Both reload on success. Each saves a restore point of the current database first, so a
      // restore that turns out wrong can still be undone from that copy.
      if (pending.kind === 'archive') await restoreArchive(pending.file, { force, save });
      else await restoreRawSqlite(pending.file, { force, save });
    } catch (error) {
      console.error('[gubbins] rescue action failed', error);
      // Nothing was written, and the user may simply want another go at saving the copy — so
      // this keeps the chosen file pending rather than sending them back to the file picker.
      if (error instanceof RestorePointNotSavedError) {
        setActionError(describeError(error, 'The restore was cancelled.'));
        setBusy(null);
        return;
      }
      // Keep the file pending for either refusal: the whole point is to offer the override on the
      // same screen. The refusal panel is the `role="alert"` here, so no second copy of the same
      // news below.
      if (error instanceof DamagedDatabaseError) {
        setRefusal({ kind: 'damaged', problems: error.problems });
        setBusy(null);
        return;
      }
      if (error instanceof IncompatibleDatabaseError) {
        setRefusal({ kind: 'incompatible' });
        setBusy(null);
        return;
      }
      setActionError(describeError(error, 'Restore failed.'));
      setBusy(null);
      setPending(null);
      setRefusal(null);
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
           * baseline check (issue #501) and the JSON dump has no importer at all — so leading with
           * either would send the user into a purge holding a file that cannot bring their data back.
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
            <strong>A copy of your current database is saved first</strong> so this can be undone — you will
            be asked where to put it, and the restore only runs once it is safely there.
          </p>
          {/*
           * The refusal report (issues #198, #501). Shown only after the checks have rejected the
           * file, and it replaces the ordinary confirm button with an explicit "restore anyway" —
           * the user has to read what is wrong before they can act on it.
           */}
          {refusal?.kind === 'damaged' ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <p className="font-medium">This database file is damaged — nothing has been changed:</p>
              <ul className="mt-1 list-disc ps-5">
                {/* Indexed keys: integrity_check happily reports the same message twice. */}
                {refusal.problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
              <p className="mt-1">
                Restoring it anyway may lose records, though SQLite can often still read most of a damaged
                database. Your current one is saved as a restore point either way.
              </p>
            </div>
          ) : null}
          {/*
           * The other refusal (issue #501): the file is intact, but was written by a version of
           * Gubbins whose database shape this one cannot open — so restoring it swaps a working
           * database for one that will not start. Points at the route that *does* work rather than
           * only saying no.
           */}
          {refusal?.kind === 'incompatible' ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <p className="font-medium">
                This file was made by a different version of Gubbins — nothing has been changed.
              </p>
              <p className="mt-1">
                Gubbins is pre-release and cannot open a database built by another version, so restoring this
                one would leave it unable to start. Use{' '}
                <span className="font-medium">Back up everything (.zip)</span> above instead, then restore
                that with <span className="font-medium">Merge</span> once Gubbins is running — that brings
                your records across a change of database shape.
              </p>
            </div>
          ) : null}
          {/*
           * Stacked, not a row: a `Button` label cannot wrap, and every "restore anyway" wording
           * is wider than the half-row this panel can spare — so side by side, the risk the user
           * is accepting was clipped mid-word on the one screen where it matters most.
           */}
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              data-testid="confirm-archive-restore"
              onClick={() => void confirmRestore(refusal !== null)}
              disabled={busy !== null}
            >
              <RestoreIcon /> {confirmRestoreLabel(refusal)}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setRefusal(null);
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

      {/* Asks whether the restore point arrived, on the browsers that cannot say (issue #502). */}
      {confirmSavedDialog}
    </div>
  );
}
