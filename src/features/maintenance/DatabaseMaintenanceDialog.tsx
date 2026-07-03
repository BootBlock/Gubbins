/**
 * Database Maintenance dialog (Settings → Database maintenance).
 *
 * Surfaces the three {@link ./db-maintenance-actions} housekeeping tasks as a small
 * modal of independent cards — each with its own Run button, spinner and inline result
 * line — mirroring the Storage-Triage dialog's shape and the Foundry primitives it uses.
 *
 * The tasks are safe and non-destructive to inventory data (compaction rewrites the same
 * rows; the health check is read-only; the orphan sweep only deletes raw OPFS files that
 * no row references), so they run on a single click with no confirm gate. After a task
 * that changes on-disk size, the storage estimate is refreshed and image-count queries
 * invalidated so the rest of the app reflects the reclaimed space.
 */
import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Modal, Spinner, useToast } from '@/components/foundry';
import {
  DatabaseIcon,
  HealthCheckIcon,
  OptimiseIcon,
  SuccessIcon,
  SweepIcon,
  WarningIcon,
} from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useStorageStore } from '@/state/stores/useStorageStore';
import {
  browserMaintenancePorts,
  checkDatabaseHealth,
  compactDatabase,
  sweepOrphanImages,
  type MaintenancePorts,
} from './db-maintenance-actions';

interface DatabaseMaintenanceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** Which task, if any, is currently running (only one runs at a time). */
type RunningTask = 'compact' | 'health' | 'sweep' | null;

/** A finished task's outcome: the tone to show it in and its message node. */
interface TaskResult {
  readonly tone: 'success' | 'warning';
  readonly node: ReactNode;
}

export function DatabaseMaintenanceDialog({ open, onClose }: DatabaseMaintenanceDialogProps) {
  // Stable ports for the dialog's lifetime (created once on mount).
  const [ports] = useState<MaintenancePorts>(() => browserMaintenancePorts());
  const [running, setRunning] = useState<RunningTask>(null);
  const [compactResult, setCompactResult] = useState<TaskResult | null>(null);
  const [healthResult, setHealthResult] = useState<TaskResult | null>(null);
  const [sweepResult, setSweepResult] = useState<TaskResult | null>(null);

  const fmt = useFormatters();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const busy = running !== null;

  async function onCompact() {
    setRunning('compact');
    setCompactResult(null);
    try {
      const result = await compactDatabase(ports);
      void useStorageStore.getState().refresh();
      const freed = fmt.bytes(result.reclaimedBytes);
      setCompactResult({
        tone: 'success',
        node:
          result.reclaimedBytes > 0
            ? `Reclaimed ${freed} — database is now ${fmt.bytes(result.afterBytes)}.`
            : `Already compact — database is ${fmt.bytes(result.afterBytes)}.`,
      });
      show({
        tone: 'success',
        icon: <OptimiseIcon />,
        heading: 'Database optimised',
        message:
          result.reclaimedBytes > 0
            ? `Compacted the database and reclaimed ${freed}.`
            : 'Compacted the database; it was already tidy.',
      });
    } catch {
      setCompactResult({ tone: 'warning', node: 'Compaction failed — nothing was changed.' });
      show({ tone: 'danger', heading: 'Optimise failed', message: 'The database was not changed.' });
    } finally {
      setRunning(null);
    }
  }

  async function onHealth() {
    setRunning('health');
    setHealthResult(null);
    try {
      const result = await checkDatabaseHealth(ports);
      if (result.ok) {
        setHealthResult({ tone: 'success', node: 'No problems found — your database is healthy.' });
        show({
          tone: 'success',
          icon: <SuccessIcon />,
          heading: 'Database healthy',
          message: 'Integrity and foreign-key checks passed.',
        });
      } else {
        setHealthResult({
          tone: 'warning',
          node: (
            <>
              <span>
                Found {result.problems.length} problem{result.problems.length === 1 ? '' : 's'}:
              </span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {result.problems.slice(0, 10).map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
                {result.problems.length > 10 ? <li>…and {result.problems.length - 10} more.</li> : null}
              </ul>
            </>
          ),
        });
        show({
          tone: 'danger',
          icon: <WarningIcon />,
          heading: 'Problems found',
          message: `The health check reported ${result.problems.length} issue(s). Consider exporting a backup.`,
        });
      }
    } catch {
      setHealthResult({ tone: 'warning', node: 'The health check could not be completed.' });
      show({ tone: 'danger', heading: 'Health check failed', message: 'Could not read the database.' });
    } finally {
      setRunning(null);
    }
  }

  async function onSweep() {
    setRunning('sweep');
    setSweepResult(null);
    try {
      const result = await sweepOrphanImages(ports);
      if (!result.supported) {
        setSweepResult({
          tone: 'warning',
          node: 'Image storage could not be read on this device — nothing was scanned.',
        });
        return;
      }
      void useStorageStore.getState().refresh();
      await queryClient.invalidateQueries();
      setSweepResult({
        tone: 'success',
        node:
          result.removed > 0
            ? `Removed ${result.removed} orphaned file(s); ${result.referenced} in-use file(s) kept.`
            : `No orphans — all ${result.scanned} image file(s) are in use.`,
      });
      show({
        tone: 'success',
        icon: <SweepIcon />,
        heading: 'Orphan sweep complete',
        message:
          result.removed > 0
            ? `Deleted ${result.removed} unreferenced image file(s).`
            : 'No orphaned image files were found.',
      });
    } catch {
      setSweepResult({ tone: 'warning', node: 'The sweep could not be completed.' });
      show({ tone: 'danger', heading: 'Sweep failed', message: 'No files were removed.' });
    } finally {
      setRunning(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Database maintenance"
      description="Keep the local database tidy, healthy and compact. These tasks never remove inventory data."
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <MaintenanceTask
          icon={<OptimiseIcon />}
          title="Compact & optimise"
          description="Merge the search index, refresh statistics and reclaim the space freed by past deletions. The database file only shrinks when you do this."
          buttonLabel="Optimise"
          testId="maintenance-compact"
          running={running === 'compact'}
          disabled={busy}
          onRun={() => void onCompact()}
          result={compactResult}
        />
        <MaintenanceTask
          icon={<HealthCheckIcon />}
          title="Check health"
          description="Run an integrity and foreign-key check. Read-only — it reports problems, it never changes your data."
          buttonLabel="Check"
          testId="maintenance-health"
          running={running === 'health'}
          disabled={busy}
          onRun={() => void onHealth()}
          result={healthResult}
        />
        <MaintenanceTask
          icon={<SweepIcon />}
          title="Remove orphaned image files"
          description="Delete raw photo files left on this device that no item refers to. Photos still attached to an item are never touched."
          buttonLabel="Sweep"
          testId="maintenance-sweep"
          running={running === 'sweep'}
          disabled={busy}
          onRun={() => void onSweep()}
          result={sweepResult}
        />
      </div>
    </Modal>
  );
}

/** One task card: icon + title + description, a Run button, and an inline result line. */
function MaintenanceTask({
  icon,
  title,
  description,
  buttonLabel,
  testId,
  running,
  disabled,
  onRun,
  result,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly buttonLabel: string;
  readonly testId: string;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly onRun: () => void;
  readonly result: TaskResult | null;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary/50 text-muted-foreground [&_svg]:size-4">
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" data-testid={`${testId}-run`} disabled={disabled} onClick={onRun}>
          {running ? <Spinner /> : <DatabaseIcon />}
          {buttonLabel}
        </Button>
      </div>
      {result ? (
        <div
          data-testid={`${testId}-result`}
          className={
            result.tone === 'success'
              ? 'text-xs text-muted-foreground'
              : 'rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground'
          }
        >
          {result.node}
        </div>
      ) : null}
    </section>
  );
}
