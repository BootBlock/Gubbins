/**
 * Database Maintenance dialog (Settings → Database maintenance).
 *
 * Surfaces the {@link ./db-maintenance-actions} housekeeping tasks as a small modal of
 * independent cards — each with its own Run button, spinner and inline result — grouped
 * into read-only "Checks & insights" (statistics, integrity, search-index and stock-total
 * verification, missing-file report) above the space-changing "Optimise & reclaim" actions.
 * The shape mirrors the Storage-Triage dialog and reuses the same Foundry primitives.
 *
 * Every task is safe to inventory data — the checks and the statistics are read-only, the
 * search-index repair only reconstructs the index from existing rows, compaction rewrites
 * the same rows, and the orphan sweep deletes only raw OPFS files that no row references —
 * so they run on a single click with no confirm gate. After a task that changes on-disk
 * size, the storage estimate is refreshed and image-count queries invalidated so the rest
 * of the app reflects the reclaimed space.
 */
import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Modal, Spinner, useToast } from '@/components/foundry';
import {
  DatabaseIcon,
  HealthCheckIcon,
  ImageIcon,
  OptimiseIcon,
  PackageIcon,
  ReportIcon,
  SearchIcon,
  SuccessIcon,
  SweepIcon,
  WarningIcon,
} from '@/components/icons';
import type { Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';
import { useStorageStore } from '@/state/stores/useStorageStore';
import {
  browserMaintenancePorts,
  checkDatabaseHealth,
  checkSearchIndex,
  compactDatabase,
  findMissingImageFiles,
  gatherDatabaseStats,
  sweepOrphanImages,
  verifyStockTotals,
  type CompactResult,
  type DatabaseStats,
  type MaintenancePorts,
  type StockDrift,
} from './db-maintenance-actions';

interface DatabaseMaintenanceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/** Which task, if any, is currently running (only one runs at a time). */
type RunningTask = 'stats' | 'health' | 'search' | 'stock' | 'missing' | 'compact' | 'sweep' | null;

/** A finished task's outcome: the tone to show it in and its message node. */
interface TaskResult {
  readonly tone: 'success' | 'warning';
  readonly node: ReactNode;
}

export function DatabaseMaintenanceDialog({ open, onClose }: DatabaseMaintenanceDialogProps) {
  // Stable ports for the dialog's lifetime (created once on mount).
  const [ports] = useState<MaintenancePorts>(() => browserMaintenancePorts());
  const [running, setRunning] = useState<RunningTask>(null);
  const [statsResult, setStatsResult] = useState<TaskResult | null>(null);
  const [healthResult, setHealthResult] = useState<TaskResult | null>(null);
  const [searchResult, setSearchResult] = useState<TaskResult | null>(null);
  const [stockResult, setStockResult] = useState<TaskResult | null>(null);
  const [missingResult, setMissingResult] = useState<TaskResult | null>(null);
  const [compactResult, setCompactResult] = useState<TaskResult | null>(null);
  const [sweepResult, setSweepResult] = useState<TaskResult | null>(null);

  const fmt = useFormatters();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const busy = running !== null;

  async function onStats() {
    setRunning('stats');
    setStatsResult(null);
    try {
      const stats = await gatherDatabaseStats(ports);
      setStatsResult({ tone: 'success', node: statsNode(stats, fmt) });
    } catch {
      setStatsResult({ tone: 'warning', node: 'The database could not be analysed.' });
    } finally {
      setRunning(null);
    }
  }

  async function onSearchIndex() {
    setRunning('search');
    setSearchResult(null);
    try {
      const result = await checkSearchIndex(ports);
      if (result.ok && !result.repaired) {
        setSearchResult({ tone: 'success', node: 'Search index verified — consistent with your items.' });
        show({
          tone: 'success',
          icon: <SuccessIcon />,
          heading: 'Search index healthy',
          message: 'The full-text index matches your items.',
        });
      } else if (result.ok) {
        setSearchResult({
          tone: 'success',
          node: 'Search index was out of step — rebuilt from your items and now consistent.',
        });
        show({
          tone: 'success',
          icon: <SearchIcon />,
          heading: 'Search index rebuilt',
          message: 'A desynced index was reconstructed from your items.',
        });
      } else {
        setSearchResult({
          tone: 'warning',
          node: 'Search index is out of step and could not be rebuilt — consider exporting a backup.',
        });
        show({
          tone: 'danger',
          heading: 'Search index unhealthy',
          message: 'The index could not be rebuilt.',
        });
      }
    } catch {
      setSearchResult({ tone: 'warning', node: 'The search index could not be checked.' });
      show({ tone: 'danger', heading: 'Search-index check failed', message: 'Could not read the index.' });
    } finally {
      setRunning(null);
    }
  }

  async function onStock() {
    setRunning('stock');
    setStockResult(null);
    try {
      const result = await verifyStockTotals(ports);
      if (result.ok) {
        setStockResult({ tone: 'success', node: 'All stock totals reconcile with the per-location ledger.' });
        show({
          tone: 'success',
          icon: <SuccessIcon />,
          heading: 'Stock totals reconcile',
          message: 'Every item and placement total matches its ledger.',
        });
      } else {
        const drift = [...result.itemDrift, ...result.placementDrift];
        setStockResult({ tone: 'warning', node: stockDriftNode(drift, fmt) });
        show({
          tone: 'danger',
          icon: <WarningIcon />,
          heading: 'Stock totals drifted',
          message: `${drift.length} total(s) disagree with the ledger. Consider exporting a backup.`,
        });
      }
    } catch {
      setStockResult({ tone: 'warning', node: 'Stock totals could not be verified.' });
      show({ tone: 'danger', heading: 'Stock check failed', message: 'Could not read the ledger.' });
    } finally {
      setRunning(null);
    }
  }

  async function onMissing() {
    setRunning('missing');
    setMissingResult(null);
    try {
      const result = await findMissingImageFiles(ports);
      if (!result.supported) {
        setMissingResult({
          tone: 'warning',
          node: 'Image storage could not be read on this device — nothing was checked.',
        });
        return;
      }
      if (result.missing === 0) {
        setMissingResult({
          tone: 'success',
          node: `All ${fmt.quantity(result.checked)} image file(s) are present on this device.`,
        });
        show({
          tone: 'success',
          icon: <SuccessIcon />,
          heading: 'All photos present',
          message: 'Every image row has its file on this device.',
        });
      } else {
        const sample = result.sampleNames.join(', ');
        const more = result.missing - result.sampleNames.length;
        setMissingResult({
          tone: 'warning',
          node: (
            <>
              <span>
                {fmt.quantity(result.missing)} of {fmt.quantity(result.checked)} image file(s) are missing on
                this device. These may be photos added on another device that this one has not downloaded yet
                — a sync brings them back.
              </span>
              {sample ? (
                <span className="mt-1 block text-muted-foreground">
                  Affected: {sample}
                  {more > 0 ? `, and ${fmt.quantity(more)} more` : ''}.
                </span>
              ) : null}
            </>
          ),
        });
        show({
          tone: 'warning',
          icon: <ImageIcon />,
          heading: 'Some photos missing locally',
          message: `${result.missing} image file(s) are not on this device.`,
        });
      }
    } catch {
      setMissingResult({ tone: 'warning', node: 'The image files could not be checked.' });
      show({ tone: 'danger', heading: 'Image check failed', message: 'Could not read image storage.' });
    } finally {
      setRunning(null);
    }
  }

  async function onCompact() {
    setRunning('compact');
    setCompactResult(null);
    try {
      const result = await compactDatabase(ports);
      void useStorageStore.getState().refresh();
      const freed = fmt.bytes(result.reclaimedBytes);
      setCompactResult({ tone: 'success', node: compactSummary(result, fmt) });
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
      busy={busy}
    >
      <div className="flex flex-col gap-6">
        <section aria-labelledby="maint-group-checks" className="flex flex-col gap-4">
          <p
            id="maint-group-checks"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Checks &amp; insights
          </p>
          <MaintenanceTask
            icon={<ReportIcon />}
            title="Database statistics"
            description="See what's in the database: file size and free space, per-table row counts, image storage, and the engine and schema versions. Read-only."
            buttonLabel="Analyse"
            testId="maintenance-stats"
            running={running === 'stats'}
            disabled={busy}
            onRun={() => void onStats()}
            result={statsResult}
            wideResult
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
            icon={<SearchIcon />}
            title="Verify search index"
            description="Check the full-text search index still matches your items, and rebuild it from your items if it has drifted. The rebuild changes no inventory data."
            buttonLabel="Verify"
            testId="maintenance-search"
            running={running === 'search'}
            disabled={busy}
            onRun={() => void onSearchIndex()}
            result={searchResult}
          />
          <MaintenanceTask
            icon={<PackageIcon />}
            title="Verify stock totals"
            description="Confirm each item's quantity still matches its per-location and per-batch ledger. Read-only — it reports any drift, it never rewrites a total."
            buttonLabel="Verify"
            testId="maintenance-stock"
            running={running === 'stock'}
            disabled={busy}
            onRun={() => void onStock()}
            result={stockResult}
            wideResult
          />
          <MaintenanceTask
            icon={<ImageIcon />}
            title="Find missing photo files"
            description="Report item photos whose full-resolution file is not on this device (often a photo added elsewhere and not yet synced). Read-only — nothing is deleted."
            buttonLabel="Check"
            testId="maintenance-missing"
            running={running === 'missing'}
            disabled={busy}
            onRun={() => void onMissing()}
            result={missingResult}
            wideResult
          />
        </section>

        <section aria-labelledby="maint-group-actions" className="flex flex-col gap-4">
          <p
            id="maint-group-actions"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Optimise &amp; reclaim
          </p>
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
        </section>
      </div>
    </Modal>
  );
}

/**
 * The inline status line for a finished compaction. Beyond "how much" (bytes reclaimed),
 * it explains "how the file was optimised": the percentage of the file returned, the
 * unused pages past deletes had left for VACUUM to reclaim, and the before/after size —
 * or a tidy note when the file was already compact and there was nothing to return.
 */
function compactSummary(result: CompactResult, fmt: Formatters): string {
  const after = fmt.bytes(result.afterBytes);
  if (result.reclaimedBytes <= 0) {
    return `Already compact — no unused space to reclaim; database is ${after}.`;
  }
  const freed = fmt.bytes(result.reclaimedBytes);
  const before = fmt.bytes(result.beforeBytes);
  // Only quote a percentage once it rounds to a non-zero figure, so a sliver of a reclaim
  // never reads a misleading "(0%)".
  const percent = result.reclaimedFraction >= 0.005 ? ` (${fmt.percent(result.reclaimedFraction)})` : '';
  const pages =
    result.freePagesBefore > 0
      ? ` from ${fmt.quantity(result.freePagesBefore)} unused ${
          result.freePagesBefore === 1 ? 'page' : 'pages'
        }`
      : '';
  return `Reclaimed ${freed}${percent}${pages} — now ${after} (was ${before}).`;
}

/**
 * A compact read-only snapshot of the database for the statistics card: the headline
 * figures as a definition list, then the busiest tables as chips. Kept terse so it reads
 * at a glance rather than as a wall of numbers.
 */
function statsNode(stats: DatabaseStats, fmt: Formatters): ReactNode {
  const TABLE_CHIP_LIMIT = 12;
  const shown = stats.tables.slice(0, TABLE_CHIP_LIMIT);
  const moreTables = stats.tables.length - shown.length;
  const freeNote =
    stats.freeBytes > 0
      ? ` · ${fmt.bytes(stats.freeBytes)} free (${fmt.quantity(stats.freePages)} ${
          stats.freePages === 1 ? 'page' : 'pages'
        })`
      : '';
  return (
    <div className="text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Database file</dt>
        <dd className="text-foreground">
          {fmt.bytes(stats.fileBytes)}
          {freeNote}
        </dd>
        <dt className="text-muted-foreground">Rows</dt>
        <dd className="text-foreground">
          {fmt.quantity(stats.totalRows)} across {fmt.quantity(stats.tables.length)}{' '}
          {stats.tables.length === 1 ? 'table' : 'tables'}
        </dd>
        <dt className="text-muted-foreground">Photos</dt>
        <dd className="text-foreground">
          {fmt.quantity(stats.imageCount)} · {fmt.bytes(stats.imageBytes)}
          {stats.imageBytesMeasured ? ' on disk' : ' (estimated)'}
        </dd>
        <dt className="text-muted-foreground">Engine</dt>
        <dd className="text-foreground">
          SQLite {stats.sqliteVersion} · schema v{stats.schemaVersion}
        </dd>
      </dl>
      {shown.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {shown.map((t) => (
            <span
              key={t.table}
              className="rounded bg-secondary/50 px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {t.table} {fmt.quantity(t.rows)}
            </span>
          ))}
          {moreTables > 0 ? (
            <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-xs text-muted-foreground">
              +{fmt.quantity(moreTables)} more
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The drift list for the stock-totals check: each subject with its declared→computed gap. */
function stockDriftNode(drift: readonly StockDrift[], fmt: Formatters): ReactNode {
  const LIMIT = 10;
  const shown = drift.slice(0, LIMIT);
  const more = drift.length - shown.length;
  return (
    <>
      <span>
        {fmt.quantity(drift.length)} total{drift.length === 1 ? '' : 's'} disagree with the ledger:
      </span>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {shown.map((d, i) => (
          <li key={i}>
            {d.subject}: shows {fmt.quantity(d.declared)}, ledger has {fmt.quantity(d.computed)}
          </li>
        ))}
        {more > 0 ? <li>…and {fmt.quantity(more)} more.</li> : null}
      </ul>
    </>
  );
}

/**
 * One task card: icon + title + description, a Run button, and its result. A short result
 * sits inline to the button's right (so a finished task never grows the card); a `wideResult`
 * task (the richer statistics / drift / missing-file reports) renders its result full-width
 * below the header instead, where a small table or list has room to breathe.
 */
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
  wideResult = false,
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
  readonly wideResult?: boolean;
}) {
  const resultBox =
    result !== null ? (
      <div
        data-testid={`${testId}-result`}
        className={
          result.tone === 'success'
            ? 'min-w-0 text-xs text-muted-foreground'
            : 'min-w-0 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-foreground'
        }
      >
        {result.node}
      </div>
    ) : null;

  return (
    <section className="rounded-lg border border-border p-4">
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
        {/* A short result shares the button's row; a wide one drops to its own block below. */}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
          <Button
            variant="outline"
            size="sm"
            data-testid={`${testId}-run`}
            disabled={disabled}
            onClick={onRun}
          >
            {running ? <Spinner /> : <DatabaseIcon />}
            {buttonLabel}
          </Button>
          {wideResult ? null : resultBox}
        </div>
      </div>
      {wideResult && resultBox ? <div className="mt-3">{resultBox}</div> : null}
    </section>
  );
}
