import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Spinner } from '@/components/foundry';
import { HistoryIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { useItemHistory } from '../queries';
import { listRowCount, resolveListRow } from '../list-window';
import { describeHistoryEntry, HISTORY_TONE_BADGE } from '../history-format';

/** Estimated entry height — also the height of a not-yet-resident placeholder. */
const ROW_HEIGHT = 56;

/**
 * The per-item Activity Log (spec §4 "Activity Log", §4.1.3) — the immutable ledger
 * of every movement, quantity change, gauge calibration, reconciliation and loan,
 * surfaced for in-app auditing. Pages come from `useItemHistory` (newest-first) and
 * render through the same bounded, absolute-indexed virtualised window as the
 * inventory list (§2.1, `list-window.ts`), so an item with thousands of gauge updates
 * stays light. The human-readable line per entry is the pure `describeHistoryEntry`.
 */
export function ActivityLog({ itemId }: { itemId: string }) {
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

  if (history.isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">No activity recorded yet.</p>;
  }

  return (
    <div
      ref={parentRef}
      data-testid="activity-log"
      aria-label="Activity log"
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
                      <HistoryIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
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
                        {view.detail ? (
                          <p className="truncate text-xs text-muted-foreground">{view.detail}</p>
                        ) : null}
                      </div>
                      <time
                        dateTime={new Date(entry.createdAt).toISOString()}
                        className="shrink-0 text-[11px] text-muted-foreground/80"
                      >
                        {fmt.dateTime(entry.createdAt)}
                      </time>
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
  );
}
