import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, Modal, Spinner } from '@/components/foundry';
import { DeleteIcon, HistoryIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { getDeviceId } from '@/lib/env/device-id';
import { useFormatters } from '@/lib/useFormatters';
import { ActivityActor } from '@/features/activity/ActivityActor';
import { buildItemActivityExport, itemActivityExportFilename } from '@/features/activity/activity-export';
import { exportEveryPage } from '@/features/export/export-every-page';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { useT } from '@/features/i18n';
import { can } from '@/features/users/permissions';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { clearedByLabel } from '../history-clear-label';
import { describeHistoryEntry, HISTORY_TONE_BADGE } from '../history-format';
import { listRowCount, resolveListRow } from '../list-window';
import { useClearItemHistory } from '../mutations';
import { HistoryChangeList } from './HistoryChangeList';
import { readItemHistoryPage, useItemHistory } from '../queries';

/** Estimated entry height — also the height of a not-yet-resident placeholder. */
const ROW_HEIGHT = 56;

/**
 * The per-item Activity Log (spec §4 "Activity Log", §4.1.3) — the immutable ledger
 * of every movement, quantity change, gauge calibration, reconciliation and loan,
 * surfaced for in-app auditing. Pages come from `useItemHistory` (newest-first) and
 * render through the same bounded, absolute-indexed virtualised window as the
 * inventory list (§2.1, `list-window.ts`), so an item with thousands of gauge updates
 * stays light. The human-readable line per entry is the pure `describeHistoryEntry`.
 *
 * Two controls sit above it (issue #620), each reusing an existing app-wide seam rather
 * than growing its own — see {@link ActivityLogControls}.
 */
export function ActivityLog({ itemId, itemName }: { itemId: string; itemName: string }) {
  const history = useItemHistory(itemId);
  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = history;
  const fmt = useFormatters();
  const t = useT();
  const parentRef = useRef<HTMLDivElement>(null);

  const pages = history.data?.pages ?? [];
  const entries = pages.flatMap((p) => p.rows);
  // Absolute index of the first resident entry — non-zero once front pages are trimmed.
  const firstItemIndex = pages[0]?.offset ?? 0;

  const rowCount = listRowCount(firstItemIndex, entries.length, 1);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualRows = virtualizer.getVirtualItems();

  // Infinite loading: fetch the next (older) page as the tail scrolls into view.
  const lastRow = virtualRows[virtualRows.length - 1];
  useEffect(() => {
    if (!lastRow) return;
    if (lastRow.index >= rowCount - 1 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [lastRow, rowCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Refill the prefix when scrolling back up into a trimmed-off region; absolute
  // indexing means the refetched page slots in above without moving the viewport.
  const firstRow = virtualRows[0];
  useEffect(() => {
    if (!firstRow) return;
    if (firstRow.index < firstItemIndex && hasPreviousPage && !isFetchingPreviousPage) {
      void fetchPreviousPage();
    }
  }, [firstRow, firstItemIndex, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage]);

  return (
    <div className="flex flex-col gap-3">
      {/* The controls stay mounted through the loading and empty states rather than appearing
          with the first page — a toolbar that pops in would shift the panel under the pointer.
          They disable instead: there is nothing to export or clear until entries arrive. */}
      <ActivityLogControls
        itemId={itemId}
        itemName={itemName}
        isEmpty={entries.length === 0}
        isLoading={history.isLoading}
      />

      {history.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{t('inventory.activityLog.empty')}</p>
      ) : (
        <div
          ref={parentRef}
          data-testid="activity-log"
          aria-label={t('inventory.activityLog.label')}
          className="max-h-72 overflow-auto rounded-lg border border-border bg-secondary/10"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => {
              const { start, resident } = resolveListRow(virtualRow.index, 1, firstItemIndex, entries.length);
              const entry = resident ? entries[start] : undefined;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {entry ? (
                    (() => {
                      const view = describeHistoryEntry(entry);
                      return (
                        <div
                          data-testid="activity-log-entry"
                          className="flex items-start gap-3 border-b border-border/50 px-3 py-2 last:border-b-0"
                        >
                          <HistoryIcon
                            aria-hidden="true"
                            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold">{view.label}</span>
                              {view.delta && view.tone !== 'neutral' ? (
                                <span
                                  className={cn(
                                    'rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                                    HISTORY_TONE_BADGE[view.tone],
                                  )}
                                >
                                  {view.delta}
                                </span>
                              ) : null}
                            </div>
                            {view.detail && !view.noteRepeatsChanges ? (
                              <p className="truncate text-xs text-muted-foreground">{view.detail}</p>
                            ) : null}
                            {view.changes.length > 0 ? <HistoryChangeList changes={view.changes} /> : null}
                          </div>
                          <div className="flex shrink-0 flex-col items-end">
                            <time
                              dateTime={new Date(entry.createdAt).toISOString()}
                              className="text-[11px] text-muted-foreground/80"
                            >
                              {fmt.dateTime(entry.createdAt)}
                            </time>
                            <ActivityActor actorDisplayName={entry.actorDisplayName} />
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <div style={{ height: ROW_HEIGHT }} aria-hidden />
                  )}
                </div>
              );
            })}
          </div>
          {history.isFetchingNextPage ? (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The Activity Log's toolbar (issue #620) — the two things a user wants to do with an audit
 * trail they are reading, each reusing an app-wide seam rather than growing its own:
 *
 *  - **Export** is the shared {@link TabularExportMenu}, so this log offers the same seven
 *    formats every other list does, with the same download and toast. It re-reads the ledger
 *    through `exportEveryPage` rather than serialising the window on screen — that window is
 *    trimmed as the user scrolls, so the file would otherwise be arbitrarily short.
 *  - **Clear** empties the log down to the single entry that records the clear (who, when and
 *    how many entries went). It is confirmed first and shown only to someone holding
 *    `audit:delete`, because destroying an audit trail is the one change in Gubbins that
 *    nothing else can rebuild — the item's own state is untouched, but its record of how it
 *    got there is gone.
 */
function ActivityLogControls({
  itemId,
  itemName,
  isEmpty,
  isLoading,
}: {
  itemId: string;
  itemName: string;
  isEmpty: boolean;
  isLoading: boolean;
}) {
  const t = useT();
  const authority = useSessionStore((state) => state.authority);
  const displayName = useSessionStore((state) => state.session?.displayName ?? null);
  const clearHistory = useClearItemHistory();
  const [confirming, setConfirming] = useState(false);

  const mayClear = can(authority, 'audit:delete');

  const confirmClear = () => {
    clearHistory.mutate(
      { id: itemId, clearedBy: clearedByLabel(displayName, getDeviceId()) },
      { onSuccess: () => setConfirming(false) },
    );
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <TabularExportMenu
        build={(format) =>
          exportEveryPage(
            readItemHistoryPage(itemId),
            (rows) => buildItemActivityExport(format, rows, itemName),
            t('export.list.truncated'),
          )
        }
        filename={itemActivityExportFilename}
        triggerLabel={t('export.list.trigger')}
        menuLabel={t('export.itemActivity.menuLabel')}
        toastHeading={t('export.itemActivity.toast')}
        disabled={isLoading || isEmpty}
        testIdPrefix="export-item-activity"
      />

      {mayClear ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirming(true)}
          disabled={isLoading || isEmpty}
          data-testid="clear-item-activity"
        >
          <DeleteIcon aria-hidden="true" />
          {t('inventory.activityLog.clear.open')}
        </Button>
      ) : null}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('inventory.activityLog.clear.title')}
        description={t('inventory.activityLog.clear.description', { vars: { name: itemName } })}
        busy={clearHistory.isPending}
      >
        {clearHistory.isError ? (
          <p role="alert" className="mb-3 text-xs text-destructive" data-testid="clear-item-activity-error">
            {t('inventory.activityLog.clear.failed')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(false)} disabled={clearHistory.isPending}>
            {t('inventory.activityLog.clear.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={confirmClear}
            disabled={clearHistory.isPending}
            data-testid="confirm-clear-item-activity"
          >
            {clearHistory.isPending ? <Spinner /> : <DeleteIcon aria-hidden="true" />}
            {t('inventory.activityLog.clear.confirm')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
