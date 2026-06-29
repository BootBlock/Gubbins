import { useRef, useState } from 'react';
import { Button } from '@/components/foundry';
import {
  ArchiveRestoreIcon,
  DatabaseIcon,
  DownloadIcon,
  ResetIcon,
  RestoreIcon,
} from '@/components/icons';
import { restoreArchive } from '@/features/archive/restore-archive';
import {
  downloadJsonDump,
  downloadRawSqlite,
  hardResetLocalData,
  restoreRawSqlite,
} from './safe-mode-actions';

/** A restore awaiting confirmation: a raw `.sqlite` binary or a full `.zip` archive. */
type PendingRestore = { kind: 'sqlite' | 'archive'; file: File };

/**
 * The shared "rescue your data" action set (spec §3) used by both the Safe Mode
 * crash fallback and the boot-failure screen. Hard reset requires a deliberate
 * second click since it is irreversible; the raw .sqlite restore (Phase 14) and the
 * full-archive restore (Phase 17 — re-hydrates OPFS images too) likewise confirm
 * before overwriting the live database.
 */
export function RescueActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const sqliteRef = useRef<HTMLInputElement>(null);
  const archiveRef = useRef<HTMLInputElement>(null);

  const run = (id: string, action: () => Promise<void>) => async () => {
    setBusy(id);
    try {
      await action();
    } catch (error) {
      console.error('[gubbins] rescue action failed', error);
    } finally {
      setBusy(null);
    }
  };

  const onFileChosen =
    (kind: PendingRestore['kind']) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = '';
      setRestoreError(null);
      setPending(file ? { kind, file } : null);
    };

  const confirmRestore = async () => {
    if (!pending) return;
    setBusy('restore');
    try {
      // Both reload on success.
      if (pending.kind === 'archive') await restoreArchive(pending.file);
      else await restoreRawSqlite(pending.file);
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : 'Restore failed.');
      setBusy(null);
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" onClick={run('sqlite', downloadRawSqlite)} disabled={busy !== null}>
        <DatabaseIcon /> Download raw .sqlite binary
      </Button>
      <Button variant="outline" onClick={run('json', downloadJsonDump)} disabled={busy !== null}>
        <DownloadIcon /> Export data (JSON)
      </Button>

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
            {pending.kind === 'archive'
              ? 'Restore the full archive '
              : 'Replace the live database with '}
            <span className="font-medium">{pending.file.name}</span>?
            {pending.kind === 'archive'
              ? ' This overwrites all local data and re-imports the full-resolution images.'
              : ' This overwrites all local data.'}
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              className="flex-1"
              data-testid="confirm-archive-restore"
              onClick={() => void confirmRestore()}
              disabled={busy !== null}
            >
              <RestoreIcon /> Confirm — restore &amp; reload
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button
            variant="outline"
            onClick={() => sqliteRef.current?.click()}
            disabled={busy !== null}
          >
            <RestoreIcon /> Restore raw .sqlite binary
          </Button>
          <Button
            variant="outline"
            onClick={() => archiveRef.current?.click()}
            disabled={busy !== null}
          >
            <ArchiveRestoreIcon /> Restore full archive (.zip)
          </Button>
        </>
      )}
      {restoreError ? <p className="text-sm text-destructive">{restoreError}</p> : null}

      {confirmingReset ? (
        <div className="flex gap-2">
          <Button
            variant="destructive"
            className="flex-1"
            onClick={run('reset', hardResetLocalData)}
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
