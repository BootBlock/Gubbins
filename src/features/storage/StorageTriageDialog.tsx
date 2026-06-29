/**
 * Storage Triage Dashboard (spec §7.6.2, §7.6.3).
 *
 * A modal the user is directed to from the critical/locked storage banners. It shows
 * an estimated OPFS breakdown by table (row count × avg byte-size, §7.6.2) and the
 * two guided reclaim workflows (§7.6.3):
 *   A. Action History Pruning — downloads a cold-storage JSON archive *before* deleting.
 *   B. Image Downgrading — drops stale full-res files, keeping thumbnails (local-only).
 *
 * Ephemeral selections live in local component state (Tier-3, §2.1). Reads/writes go
 * through the storage hooks; a Toast confirms each reclaim.
 */
import { useMemo, useState } from 'react';
import { Button, Modal, Select, Spinner, Tooltip, useToast } from '@/components/foundry';
import {
  ArchiveIcon,
  DownloadIcon,
  HistoryIcon,
  ImageIcon,
  PackageIcon,
  StorageIcon,
  SuccessIcon,
} from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { WINDOW_MONTH_OPTIONS } from '@/features/settings/settings';
import {
  useArchiveAndPruneHistory,
  useDowngradeCandidateCount,
  useDowngradeImages,
  usePruneCandidateCount,
  useStorageBreakdown,
} from './hooks';
import { monthsLabel, pruneCutoff } from './triage';

/** Which reclaim workflow is awaiting a confirm-before-delete (§7.6.3 nicety). */
type Confirming = 'prune' | 'downgrade' | null;

interface StorageTriageDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function StorageTriageDialog({ open, onClose }: StorageTriageDialogProps) {
  // A mount-stable "now" keeps the derived cutoffs (and their query keys) steady.
  const [now] = useState(() => Date.now());
  // The windows are user preferences (§3): bound to the store so they match the
  // Settings screen and persist between sessions (single source of truth).
  const pruneMonths = usePreferencesStore((s) => s.pruneWindowMonths);
  const downgradeMonths = usePreferencesStore((s) => s.downgradeWindowMonths);
  const setPruneMonths = usePreferencesStore((s) => s.setPruneWindowMonths);
  const setDowngradeMonths = usePreferencesStore((s) => s.setDowngradeWindowMonths);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const fmt = useFormatters();

  const pruneCutoffMs = useMemo(() => pruneCutoff(now, pruneMonths), [now, pruneMonths]);
  const downgradeCutoffMs = useMemo(() => pruneCutoff(now, downgradeMonths), [now, downgradeMonths]);

  const estimate = useStorageStore((s) => s.estimate);
  const ratio = useStorageStore((s) => s.ratio);

  const breakdown = useStorageBreakdown();
  const pruneCount = usePruneCandidateCount(pruneCutoffMs);
  const downgradeCount = useDowngradeCandidateCount(downgradeCutoffMs);

  const prune = useArchiveAndPruneHistory(now);
  const downgrade = useDowngradeImages(now);
  const { show } = useToast();

  const onPrune = () => {
    setConfirming(null);
    prune.mutate(pruneMonths, {
      onSuccess: (result) => {
        show({
          tone: 'success',
          icon: <ArchiveIcon />,
          heading: 'History archived & pruned',
          message:
            result.pruned === 0
              ? 'No history was older than that window.'
              : `Archived ${result.archived} entries to a JSON download and freed ${result.pruned} rows.`,
        });
      },
      onError: () =>
        show({ tone: 'danger', heading: 'Pruning failed', message: 'No history was deleted.' }),
    });
  };

  const onDowngrade = () => {
    setConfirming(null);
    downgrade.mutate(downgradeMonths, {
      onSuccess: (result) => {
        show({
          tone: 'success',
          icon: <ImageIcon />,
          heading: 'Images downgraded',
          message:
            result.downgraded === 0
              ? 'No images were older than that window.'
              : `Dropped full-resolution data for ${result.downgraded} image(s); thumbnails kept.`,
        });
      },
      onError: () =>
        show({ tone: 'danger', heading: 'Downgrade failed', message: 'No images were changed.' }),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Storage triage"
      description="Reclaim local space without losing your active inventory."
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-6">
        <section aria-labelledby="triage-breakdown" className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <StorageIcon />
            <h3 id="triage-breakdown" className="text-sm font-semibold">
              What's using your storage
            </h3>
          </div>
          {estimate?.supported ? (
            <p className="text-sm text-muted-foreground">
              {fmt.bytes(estimate.usage)} of {fmt.bytes(estimate.quota)} used ({fmt.percent(ratio)}).
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your browser does not report a storage quota; the estimates below are approximate.
            </p>
          )}
          {breakdown.isPending ? (
            <Spinner />
          ) : breakdown.data ? (
            <>
              <StorageBreakdownBars
                items={[
                  { key: 'images', label: 'Images', icon: <ImageIcon />, bytes: breakdown.data.bytes.itemImages },
                  { key: 'history', label: 'Activity history', icon: <HistoryIcon />, bytes: breakdown.data.bytes.itemHistory },
                  { key: 'items', label: 'Item records', icon: <PackageIcon />, bytes: breakdown.data.bytes.items },
                ]}
                total={breakdown.data.bytes.total}
              />
              <p className="text-xs text-muted-foreground" data-testid="triage-images-source">
                {breakdown.data.imagesMeasured
                  ? 'Image size measured from the actual files on your device.'
                  : 'Figures are estimated from row counts.'}
              </p>
            </>
          ) : null}
        </section>

        <section aria-labelledby="triage-history" className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <HistoryIcon />
            <h3 id="triage-history" className="text-sm font-semibold">
              Purge old activity history
            </h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Downloads a JSON cold-storage archive first, then removes the entries from your device.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">
              Older than{' '}
              <Select
                aria-label="Purge history older than"
                data-testid="prune-months"
                className="ml-1 inline-block h-9 w-auto"
                value={pruneMonths}
                onChange={(e) => setPruneMonths(Number(e.target.value))}
              >
                {WINDOW_MONTH_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {monthsLabel(m)}
                  </option>
                ))}
              </Select>
            </label>
            <span className="text-sm text-muted-foreground">
              {pruneCount.data ?? 0} entr{(pruneCount.data ?? 0) === 1 ? 'y' : 'ies'} affected
            </span>
            {confirming === 'prune' ? (
              <ConfirmRow
                testIdPrefix="prune"
                message={`Permanently delete ${pruneCount.data ?? 0} entr${(pruneCount.data ?? 0) === 1 ? 'y' : 'ies'} after the archive downloads?`}
                onConfirm={onPrune}
                onCancel={() => setConfirming(null)}
                pending={prune.isPending}
              />
            ) : (
              <Tooltip
                content="Downloads a JSON cold-storage archive first, then permanently deletes those history entries from this device."
                triggerTabIndex={-1}
              >
                <span>
                  <Button
                    data-testid="prune-history"
                    variant="outline"
                    onClick={() => setConfirming('prune')}
                    disabled={prune.isPending || (pruneCount.data ?? 0) === 0}
                  >
                    {prune.isPending ? <Spinner /> : <DownloadIcon />}
                    Archive &amp; purge
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
        </section>

        <section aria-labelledby="triage-images" className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <ImageIcon />
            <h3 id="triage-images" className="text-sm font-semibold">
              Downgrade old images
            </h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Drops full-resolution photos to reclaim space, keeping the thumbnails. Your cloud backup
            is left untouched.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">
              Older than{' '}
              <Select
                aria-label="Downgrade images older than"
                data-testid="downgrade-months"
                className="ml-1 inline-block h-9 w-auto"
                value={downgradeMonths}
                onChange={(e) => setDowngradeMonths(Number(e.target.value))}
              >
                {WINDOW_MONTH_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {monthsLabel(m)}
                  </option>
                ))}
              </Select>
            </label>
            <span className="text-sm text-muted-foreground">
              {downgradeCount.data ?? 0} image{(downgradeCount.data ?? 0) === 1 ? '' : 's'} affected
            </span>
            {confirming === 'downgrade' ? (
              <ConfirmRow
                testIdPrefix="downgrade"
                message={`Drop full-resolution data for ${downgradeCount.data ?? 0} image${(downgradeCount.data ?? 0) === 1 ? '' : 's'}? Thumbnails are kept.`}
                onConfirm={onDowngrade}
                onCancel={() => setConfirming(null)}
                pending={downgrade.isPending}
              />
            ) : (
              <Tooltip
                content="Drops the full-resolution photo data locally, keeping the thumbnails. Your cloud backup is left untouched."
                triggerTabIndex={-1}
              >
                <span>
                  <Button
                    data-testid="downgrade-images"
                    variant="outline"
                    onClick={() => setConfirming('downgrade')}
                    disabled={downgrade.isPending || (downgradeCount.data ?? 0) === 0}
                  >
                    {downgrade.isPending ? <Spinner /> : <SuccessIcon />}
                    Downgrade
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}

/**
 * Inline confirm-before-delete step (§7.6.3 nicety). An explicit guard in front of
 * the space-freeing actions; kept inline (not a nested modal) so it sits naturally
 * within the workflow row. The prune still downloads its cold-storage archive first.
 */
function ConfirmRow({
  testIdPrefix,
  message,
  onConfirm,
  onCancel,
  pending,
}: {
  readonly testIdPrefix: string;
  readonly message: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2" role="alertdialog" aria-label="Confirm">
      <span className="text-sm font-medium">{message}</span>
      <Button
        data-testid={`${testIdPrefix}-confirm`}
        variant="destructive"
        size="sm"
        onClick={onConfirm}
        disabled={pending}
      >
        {pending ? <Spinner /> : null}
        Confirm
      </Button>
      <Button
        data-testid={`${testIdPrefix}-cancel`}
        variant="ghost"
        size="sm"
        onClick={onCancel}
        disabled={pending}
      >
        Cancel
      </Button>
    </span>
  );
}

interface BreakdownBar {
  readonly key: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly bytes: number;
}

function StorageBreakdownBars({ items, total }: { items: readonly BreakdownBar[]; total: number }) {
  const fmt = useFormatters();
  return (
    <ul className="flex flex-col gap-2">
      {items.map((row) => {
        const pct = total > 0 ? row.bytes / total : 0;
        return (
          <li key={row.key} className="flex items-center gap-3 text-sm" data-testid={`triage-row-${row.key}`}>
            <span className="flex w-36 shrink-0 items-center gap-2 [&_svg]:size-4">
              {row.icon}
              {row.label}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-emphasized"
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
              {fmt.bytes(row.bytes)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
