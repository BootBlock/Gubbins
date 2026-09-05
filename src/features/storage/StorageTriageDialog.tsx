/**
 * Storage Triage Dashboard (spec §7.6.2, §7.6.3).
 *
 * A modal the user is directed to from the critical/locked storage banners. It shows
 * an estimated OPFS breakdown by table (row count × avg byte-size, §7.6.2) and the
 * two guided reclaim workflows (§7.6.3):
 *   A. Action History Pruning — saves a cold-storage JSON archive, confirms it landed,
 *      and only then deletes.
 *   B. Image Downgrading — drops stale full-res files, keeping thumbnails (local-only).
 *
 * Ephemeral selections live in local component state (Tier-3, §2.1). Reads/writes go
 * through the storage hooks; a Toast confirms each reclaim.
 */
import { useMemo, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button, Modal, Select, Spinner, Tooltip, useToast } from '@/components/foundry';
import { useConfirmSaved } from '@/components/useConfirmSaved';
import { prepareSave } from '@/lib/save-file';
import {
  ArchiveIcon,
  DownloadIcon,
  HistoryIcon,
  ImageIcon,
  PackageIcon,
  StorageIcon,
  SuccessIcon,
} from '@/components/icons';
import { plural } from '@/lib/plural';
import { useT } from '@/features/i18n';
import { usePermission } from '@/features/users/usePermission';
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
import { HISTORY_ARCHIVE_FILE_KIND, historyArchiveFilename } from './triage-actions';
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
  /**
   * True while the archive's save destination is being chosen (issue #502). The mutation has not
   * started yet, so `prune.isPending` is still false — without this the workflow's button comes
   * back enabled underneath an open save dialog, and a second click would run the whole prune
   * twice.
   */
  const [choosingArchiveDestination, setChoosingArchiveDestination] = useState(false);
  const fmt = useFormatters();
  const t = useT();
  /**
   * The two reclaim workflows answer to **different** keys, because the repositories behind them
   * do (issue #429). Downgrading images is `storage:write`, this device's own housekeeping. Purging
   * history destroys an audit trail, so `StorageRepository.pruneHistoryBefore` asserts
   * `audit:delete` — the same key the per-item history clear has always used — and gating both
   * sections on `storage:write` would have shown one role a button that throws and refused another
   * a capability it holds.
   *
   * A role with neither still sees the breakdown: knowing what is using the space is what the
   * banner sent them here for. What it is not offered is a door the gate will not open, so each
   * section is hidden outright rather than shown disabled.
   */
  const mayDowngrade = usePermission('storage:write');
  const mayPrune = usePermission('audit:delete');

  const pruneCutoffMs = useMemo(() => pruneCutoff(now, pruneMonths), [now, pruneMonths]);
  const downgradeCutoffMs = useMemo(() => pruneCutoff(now, downgradeMonths), [now, downgradeMonths]);

  const estimate = useStorageStore((s) => s.estimate);
  const ratio = useStorageStore((s) => s.ratio);
  // A write that actually ran out of space outranks the figures above it (issue #504) — and when
  // the estimate still shows headroom, saying so is the difference between an explanation and a
  // contradiction.
  const observedFull = useStorageStore((s) => s.exhaustion !== null);

  const breakdown = useStorageBreakdown();
  const pruneCount = usePruneCandidateCount(pruneCutoffMs);
  const downgradeCount = useDowngradeCandidateCount(downgradeCutoffMs);
  /**
   * The candidate figures, but only once they are *facts* — `null` while a count is still in
   * flight or has failed (issue #898). Everything below reads these rather than the query's
   * `data`, so an unknown count can never be spent as a zero: `data ?? 0` greyed the workflow
   * out with "0 entries affected" beside it, which reads as "nothing to reclaim" to the one
   * user who is here precisely because there is.
   */
  const pruneReady = pruneCount.isSuccess ? pruneCount.data : null;
  const downgradeReady = downgradeCount.isSuccess ? downgradeCount.data : null;
  // "There is nothing to reclaim" and "we do not know what there is to reclaim" both leave the
  // button unusable, but only the first is something we know — hence the explicit `!== null`.
  const canPrune = pruneReady !== null && pruneReady > 0;
  const canDowngrade = downgradeReady !== null && downgradeReady > 0;

  const prune = useArchiveAndPruneHistory(now);
  const downgrade = useDowngradeImages(now);
  const { show } = useToast();
  const { confirmSaved, confirmSavedDialog } = useConfirmSaved();

  const onPrune = async () => {
    // The markup below never renders this workflow without the permission; the guard is here
    // so a stale handler cannot outlive a revoked grant.
    if (!mayPrune) return;
    setConfirming(null);
    // Reserve the destination inside the click (issue #502). The picker that can actually report
    // a completed save needs the user gesture, and the rows are not read until it resolves —
    // so choosing first is what lets the prune wait on a copy that provably exists.
    // Released in a `finally` rather than after the await: the dialog now refuses to close while
    // this is set, so a throw on the way to a destination would strand the user in a dialog with
    // no way out rather than merely leaving a button greyed.
    setChoosingArchiveDestination(true);
    let saver;
    try {
      saver = await prepareSave(historyArchiveFilename(now), HISTORY_ARCHIVE_FILE_KIND);
    } finally {
      setChoosingArchiveDestination(false);
    }
    if (!saver) return; // the user closed the save dialog: nothing is archived and nothing deleted
    prune.mutate(
      { months: pruneMonths, save: { saver, confirmUnverified: confirmSaved } },
      {
        onSuccess: (result) => {
          if (!result.archiveSaved) {
            show({
              tone: 'warning',
              icon: <ArchiveIcon />,
              heading: 'Nothing was deleted',
              message: 'The archive was not confirmed as saved, so your history is exactly as it was.',
            });
            return;
          }
          show({
            tone: 'success',
            icon: <ArchiveIcon />,
            heading: 'History archived & pruned',
            message:
              result.pruned === 0
                ? 'No history was older than that window.'
                : `Archived ${result.archived} entries to ${saver.filename} and freed ${result.pruned} rows.`,
          });
        },
        onError: () =>
          show({ tone: 'danger', heading: 'Pruning failed', message: 'No history was deleted.' }),
      },
    );
  };

  const onDowngrade = () => {
    if (!mayDowngrade) return;
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
      // The archive's destination picker counts as work in flight alongside the two mutations: the
      // prune has not started while it is open, so its own `isPending` does not cover that window.
      busy={prune.isPending || downgrade.isPending || choosingArchiveDestination}
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
          {observedFull ? (
            <p className="text-sm font-medium text-destructive" data-testid="triage-observed-full">
              {t('storage.triage.observedFull')}
            </p>
          ) : null}
          {breakdown.isPending ? (
            <Spinner />
          ) : breakdown.data ? (
            <>
              <StorageBreakdownBars
                items={[
                  {
                    key: 'images',
                    label: 'Images',
                    icon: <ImageIcon />,
                    bytes: breakdown.data.bytes.photos,
                  },
                  {
                    key: 'history',
                    label: 'Activity history',
                    icon: <HistoryIcon />,
                    bytes: breakdown.data.bytes.itemHistory,
                  },
                  {
                    key: 'items',
                    label: 'Item records',
                    icon: <PackageIcon />,
                    bytes: breakdown.data.bytes.items,
                  },
                ]}
                total={breakdown.data.bytes.total}
              />
              <p className="text-xs text-muted-foreground" data-testid="triage-images-source">
                {breakdown.data.imagesMeasured
                  ? 'Image size measured from the actual files on your device. '
                  : 'Figures are estimated from row counts. '}
                The total above is your browser&rsquo;s storage across all sites, not Gubbins alone; the
                breakdown here is Gubbins&rsquo; own share.
              </p>
            </>
          ) : null}
        </section>

        {mayPrune ? (
          <section
            aria-labelledby="triage-history"
            className="flex flex-col gap-3 border-t border-border pt-4"
          >
            <div className="flex items-center gap-2">
              <HistoryIcon />
              <h3 id="triage-history" className="text-sm font-semibold">
                Purge old activity history
              </h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Saves a JSON cold-storage archive first, and removes the entries from your device only once that
              copy is confirmed.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Older than{' '}
                <Select
                  aria-label="Purge history older than"
                  data-testid="prune-months"
                  className="ml-1 inline-block h-9 w-auto"
                  value={String(pruneMonths)}
                  onChange={(value) => setPruneMonths(Number(value))}
                  options={WINDOW_MONTH_OPTIONS.map((m) => ({ value: String(m), label: monthsLabel(m) }))}
                />
              </label>
              <CandidateCount
                query={pruneCount}
                testIdPrefix="prune"
                label={(count) => t('storage.triage.pruneCount', { vars: { count } })}
                errorText={t('storage.triage.pruneCountFailed')}
              />
              {/*
               * The window Select stays live underneath an open confirmation, and changing it
               * re-keys the count query — so the figure this question names can stop being known
               * while the question is still on screen. Falling back to the button (disabled, with
               * the row above saying why) is the only honest move: a confirmation is the last
               * place a guessed zero may stand in for an unknown one.
               */}
              {confirming === 'prune' && pruneReady !== null ? (
                <ConfirmRow
                  testIdPrefix="prune"
                  message={`Permanently delete ${pruneReady} ${plural(pruneReady, 'entry', 'entries')} once the archive is saved?`}
                  onConfirm={() => void onPrune()}
                  onCancel={() => setConfirming(null)}
                  pending={prune.isPending}
                />
              ) : (
                <Tooltip
                  content="Saves a JSON cold-storage archive first, and permanently deletes those history entries from this device only once that copy is confirmed."
                  triggerTabIndex={-1}
                >
                  <span>
                    <Button
                      data-testid="prune-history"
                      variant="outline"
                      onClick={() => setConfirming('prune')}
                      disabled={prune.isPending || choosingArchiveDestination || !canPrune}
                    >
                      {prune.isPending || choosingArchiveDestination ? <Spinner /> : <DownloadIcon />}
                      Archive &amp; purge
                    </Button>
                  </span>
                </Tooltip>
              )}
            </div>
          </section>
        ) : null}

        {mayDowngrade ? (
          <section
            aria-labelledby="triage-images"
            className="flex flex-col gap-3 border-t border-border pt-4"
          >
            <div className="flex items-center gap-2">
              <ImageIcon />
              <h3 id="triage-images" className="text-sm font-semibold">
                Downgrade old images
              </h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Drops full-resolution photos to reclaim space, keeping the thumbnails. Your cloud backup is left
              untouched.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Older than{' '}
                <Select
                  aria-label="Downgrade images older than"
                  data-testid="downgrade-months"
                  className="ml-1 inline-block h-9 w-auto"
                  value={String(downgradeMonths)}
                  onChange={(value) => setDowngradeMonths(Number(value))}
                  options={WINDOW_MONTH_OPTIONS.map((m) => ({ value: String(m), label: monthsLabel(m) }))}
                />
              </label>
              <CandidateCount
                query={downgradeCount}
                testIdPrefix="downgrade"
                label={(count) => t('storage.triage.downgradeCount', { vars: { count } })}
                errorText={t('storage.triage.downgradeCountFailed')}
              />
              {/* Same reasoning as the prune confirmation above. */}
              {confirming === 'downgrade' && downgradeReady !== null ? (
                <ConfirmRow
                  testIdPrefix="downgrade"
                  message={`Drop full-resolution data for ${downgradeReady} ${plural(downgradeReady, 'image')}? Thumbnails are kept.`}
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
                      disabled={downgrade.isPending || !canDowngrade}
                    >
                      {downgrade.isPending ? <Spinner /> : <SuccessIcon />}
                      Downgrade
                    </Button>
                  </span>
                </Tooltip>
              )}
            </div>
          </section>
        ) : null}
      </div>
      {/*
       * Nested inside this dialog deliberately: it only ever opens on top of the workflow that
       * asked the question, and the modal stack hands Escape/Tab to whichever is topmost.
       */}
      {confirmSavedDialog}
    </Modal>
  );
}

/**
 * The candidate figure a reclaim decision rests on, in whichever of its three states the query is
 * actually in (issue #898).
 *
 * Rendering `data ?? 0` collapsed all three into one: a count still in flight, and a count whose
 * query had failed, both read out as a confident "0 entries affected" beside a button greyed out
 * for what looks like the same reason. Nothing said the figure was unknown, nothing offered to try
 * again, and the healthy sibling section stayed live — so a user sent here by a storage banner was
 * told, with every appearance of certainty, that there was nothing here to free. The breakdown
 * above has always branched on its own query state; these rows now do the same, and a failure
 * carries the retry that a permanently dead button never could.
 */
function CandidateCount({
  query,
  testIdPrefix,
  label,
  errorText,
}: {
  readonly query: UseQueryResult<number>;
  readonly testIdPrefix: string;
  /**
   * Rendered only on the success branch, and handed the settled figure — so a caller cannot
   * reach for a `?? 0` placeholder to satisfy a string it does not have yet.
   */
  readonly label: (count: number) => string;
  readonly errorText: string;
}) {
  const t = useT();
  if (query.isPending) {
    return (
      <span
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid={`${testIdPrefix}-count-pending`}
      >
        {/* Decorative: the spinner's own `role="status"` would announce a bare "Loading" next to
            text that already says so, and would fire again on every change of the window. */}
        <Spinner decorative />
        {t('storage.triage.countPending')}
      </span>
    );
  }
  if (query.isError) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span role="alert" className="text-sm text-destructive" data-testid={`${testIdPrefix}-count-error`}>
          {errorText}
        </span>
        <Button
          data-testid={`${testIdPrefix}-count-retry`}
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? <Spinner decorative /> : null}
          {t('storage.triage.countRetry')}
        </Button>
      </span>
    );
  }
  return (
    <span className="text-sm text-muted-foreground" data-testid={`${testIdPrefix}-count`}>
      {label(query.data)}
    </span>
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
