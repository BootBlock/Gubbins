import { useState } from 'react';
import { Banner, Button, Modal, Surface } from '@/components/foundry';
import { RestoreIcon, SubstituteIcon, WarningIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useSyncConflictsStore } from './conflict-store';
import { diffConflict } from './conflict-diff';
import { restoreConflictVersion } from './conflict-restore';
import { getSyncDriver } from './runtime';
import type { SyncConflict } from './types';

interface SyncConflictsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called after a restore writes to the database, so the host can refresh its data views. */
  readonly onRestored?: () => void;
}

/**
 * Review the sync collisions this device recorded (issue #72).
 *
 * When a sync overwrote or deleted an edit the user made since their last sync, LWW kept the
 * other side silently. This dialog surfaces each such loss with a field-by-field comparison,
 * and lets the user either keep the current (won) version or restore their discarded one —
 * turning a silent overwrite into a reviewable, recoverable choice. The conflict list lives
 * in a device-local persisted store, so it survives reloads until every entry is resolved.
 */
export function SyncConflictsDialog({ open, onClose, onRestored }: SyncConflictsDialogProps) {
  const conflicts = useSyncConflictsStore((s) => s.conflicts);
  const resolve = useSyncConflictsStore((s) => s.resolve);
  const clear = useSyncConflictsStore((s) => s.clear);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore(conflict: SyncConflict) {
    setBusyId(conflict.id);
    setError(null);
    try {
      await restoreConflictVersion(getSyncDriver(), conflict);
      resolve(conflict.id);
      onRestored?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore that version.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review sync conflicts"
      description="These edits you made were overwritten when a device synced a change to the same thing at the same time. Keep the current version, or restore yours."
    >
      {error ? (
        <Banner tone="danger" role="alert" className="mb-4">
          {error}
        </Banner>
      ) : null}

      {conflicts.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="conflicts-empty">
          No conflicts to review — everything is up to date.
        </p>
      ) : (
        <div className="space-y-4">
          <ul className="space-y-4">
            {conflicts.map((conflict) => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                busy={busyId === conflict.id}
                anyBusy={busyId !== null}
                onKeep={() => resolve(conflict.id)}
                onRestore={() => void restore(conflict)}
              />
            ))}
          </ul>
          {conflicts.length > 1 ? (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={clear} disabled={busyId !== null}>
                Dismiss all
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

interface ConflictCardProps {
  readonly conflict: SyncConflict;
  readonly busy: boolean;
  readonly anyBusy: boolean;
  readonly onKeep: () => void;
  readonly onRestore: () => void;
}

function ConflictCard({ conflict, busy, anyBusy, onKeep, onRestore }: ConflictCardProps) {
  const fmt = useFormatters();
  const diffs = diffConflict(conflict);
  const isDelete = conflict.kind === 'DELETE';

  return (
    <li>
      <Surface className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-medium">
              <WarningIcon aria-hidden className="size-4 shrink-0 text-warning" />
              <span className="truncate">{conflict.entityLabel}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {isDelete
                ? 'Deleted on another device after you edited it'
                : 'Overwritten by a change from another device'}{' '}
              · {conflict.tableName} · {fmt.relativeTime(conflict.detectedAt)}
            </p>
          </div>
        </div>

        {diffs.length > 0 ? (
          <dl className="divide-y divide-border rounded-lg border border-border text-sm">
            <div className="grid grid-cols-[minmax(0,8rem)_1fr_1fr] gap-2 bg-muted/40 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <span>Field</span>
              <span>Your version</span>
              <span>{isDelete ? 'On the other device' : 'Current (kept)'}</span>
            </div>
            {diffs.map((d) => (
              <div key={d.column} className="grid grid-cols-[minmax(0,8rem)_1fr_1fr] gap-2 px-3 py-1.5">
                <dt className="truncate text-muted-foreground">{humanizeColumn(d.column)}</dt>
                <dd className="min-w-0 break-words text-glyph-success">{d.mine}</dd>
                <dd className="min-w-0 break-words">{d.theirs ?? 'Deleted'}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onKeep} disabled={anyBusy}>
            <SubstituteIcon />
            Keep current
          </Button>
          <Button size="sm" onClick={onRestore} disabled={anyBusy}>
            <RestoreIcon />
            {busy ? 'Restoring…' : isDelete ? 'Restore mine' : 'Use my version'}
          </Button>
        </div>
      </Surface>
    </li>
  );
}

/** Turn a snake_case column name into a readable label ("expiry_date" → "Expiry date"). */
function humanizeColumn(column: string): string {
  const words = column.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
