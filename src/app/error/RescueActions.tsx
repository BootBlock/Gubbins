import { useState } from 'react';
import { Button } from '@/components/foundry';
import { DatabaseIcon, DownloadIcon, ResetIcon } from '@/components/icons';
import { downloadJsonDump, downloadRawSqlite, hardResetLocalData } from './safe-mode-actions';

/**
 * The shared "rescue your data" action set (spec §3) used by both the Safe Mode
 * crash fallback and the boot-failure screen. Hard reset requires a deliberate
 * second click since it is irreversible.
 */
export function RescueActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

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

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" onClick={run('sqlite', downloadRawSqlite)} disabled={busy !== null}>
        <DatabaseIcon /> Download raw .sqlite binary
      </Button>
      <Button variant="outline" onClick={run('json', downloadJsonDump)} disabled={busy !== null}>
        <DownloadIcon /> Export data (JSON)
      </Button>

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
