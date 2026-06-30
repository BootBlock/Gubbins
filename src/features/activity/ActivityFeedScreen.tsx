/**
 * ActivityFeedScreen — the global cross-item activity feed (Phase 80, Wave 3 #6).
 *
 * Folds **every** `item_history` event across all items into one chronological,
 * newest-first stream — the global counterpart to the per-item Phase-52 Activity Log.
 * Read-only; composes the immutable ledger joined to `items` for the name. Reuses the
 * Phase-52 pure `describeHistoryEntry` seam for each row and the Phase-37 absolute-index
 * virtualised window (`list-window.ts`), so the feed stays light against 100,000+ rows.
 * An optional kind-filter chip row narrows the feed (filtered in SQL so pagination stays
 * correct), and each row links back to the inventory.
 *
 * Accessibility (§3 WCAG 4.1.3): an always-mounted `<LiveRegion>` announces the loaded
 * count once loading settles (Phase 63). The screen carries `id={MAIN_CONTENT_ID}` for
 * the skip-to-content link (Phase 40).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LiveRegion, MAIN_CONTENT_ID, Spinner, Surface } from '@/components/foundry';
import { HistoryIcon, PackageIcon } from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { listRowCount, resolveListRow } from '@/features/inventory/list-window';
import { describeHistoryEntry, type HistoryTone } from '@/features/inventory/history-format';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABEL,
  actionsForKinds,
  type ActivityKind,
} from './activity-kind';
import { useActivityFeed } from './queries';

/** Estimated entry height — also the height of a not-yet-resident placeholder. */
const ROW_HEIGHT = 64;

const TONE_BADGE: Record<Exclude<HistoryTone, 'neutral'>, string> = {
  positive: 'bg-success/15 text-success',
  negative: 'bg-secondary text-muted-foreground',
};

// ---------------------------------------------------------------------------
// Kind filter — a token-styled toggle row (mirrors the agenda's kind filter)
// ---------------------------------------------------------------------------

function KindFilter({
  enabled,
  onToggle,
}: {
  enabled: ReadonlySet<ActivityKind>;
  onToggle: (kind: ActivityKind) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-lg bg-secondary/60 p-0.5"
      role="group"
      aria-label="Filter by kind"
    >
      {ACTIVITY_KINDS.map((kind) => {
        const active = enabled.has(kind);
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onToggle(kind)}
            aria-pressed={active}
            data-testid={`activity-filter-${kind}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {ACTIVITY_KIND_LABEL[kind]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function ActivityFeedScreen() {
  const fmt = useFormatters();
  const parentRef = useRef<HTMLDivElement>(null);

  // All kinds enabled by default; toggling a chip filters the feed. When every kind is
  // enabled the resolved action list covers all actions, so we pass `undefined` and the
  // repository skips the WHERE clause (the common "show everything" path).
  const [enabledKinds, setEnabledKinds] = useState<Set<ActivityKind>>(() => new Set(ACTIVITY_KINDS));
  const toggleKind = (kind: ActivityKind) =>
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const actions = useMemo(() => {
    const allEnabled = enabledKinds.size === ACTIVITY_KINDS.length;
    return allEnabled ? undefined : actionsForKinds(enabledKinds);
  }, [enabledKinds]);

  const feed = useActivityFeed(actions);
  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    fetchPreviousPage,
    hasPreviousPage,
    isFetchingPreviousPage,
  } = feed;

  const pages = data?.pages ?? [];
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
      fetchNextPage();
    }
  }, [lastRow, rowCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Refill the prefix when scrolling back up into a trimmed-off region; absolute
  // indexing means the refetched page slots in above without moving the viewport.
  const firstRow = virtualRows[0];
  useEffect(() => {
    if (!firstRow) return;
    if (firstRow.index < firstItemIndex && hasPreviousPage && !isFetchingPreviousPage) {
      fetchPreviousPage();
    }
  }, [firstRow, firstItemIndex, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage]);

  // Announce the loaded count once the first load settles (WCAG 4.1.3), once only.
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef(false);
  useEffect(() => {
    if (isLoading || announcedRef.current) return;
    announcedRef.current = true;
    const n = entries.length;
    setAnnouncement(n === 0 ? 'No recent activity.' : `Showing ${n} recent event${n === 1 ? '' : 's'}.`);
  }, [isLoading, entries.length]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <BrandMark className="size-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <HistoryIcon />
          Activity
        </h1>
        <Link
          to="/inventory"
          className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <PackageIcon />
          Inventory
        </Link>
      </header>

      <p className="text-sm text-muted-foreground">
        Every recent change across your whole inventory, newest first.
      </p>

      <KindFilter enabled={enabledKinds} onToggle={toggleKind} />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none" data-testid="activity-main">
        {isLoading && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {isError && !isLoading && (
          <Surface className="p-6 text-center text-sm text-destructive">
            Failed to load activity. Please refresh the page.
          </Surface>
        )}

        {!isLoading && !isError && entries.length === 0 && (
          <Surface className="flex flex-col items-center gap-3 p-12 text-center">
            <HistoryIcon className="size-10 text-muted-foreground" />
            <p className="font-medium">No activity to show</p>
            <p className="text-sm text-muted-foreground">
              {enabledKinds.size === 0
                ? 'Enable a kind above to see activity.'
                : 'Changes to your inventory will appear here as they happen.'}
            </p>
          </Surface>
        )}

        {!isLoading && !isError && entries.length > 0 && (
          <div
            ref={parentRef}
            data-testid="activity-feed"
            aria-label="Activity feed"
            className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-secondary/10"
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
                            data-testid="activity-feed-entry"
                            className="flex items-start gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0"
                          >
                            <HistoryIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link
                                  to="/inventory"
                                  className="truncate text-xs font-semibold text-foreground underline-offset-2 hover:underline"
                                  data-testid={`activity-item-link-${entry.id}`}
                                >
                                  {entry.itemName}
                                </Link>
                                <span className="text-xs text-muted-foreground">{view.label}</span>
                                {view.delta && view.tone !== 'neutral' ? (
                                  <span
                                    className={cn(
                                      'rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                                      TONE_BADGE[view.tone],
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
            {isFetchingNextPage ? (
              <div className="flex justify-center py-2">
                <Spinner />
              </div>
            ) : null}
          </div>
        )}
      </main>

      {/* Always-mounted live region (WCAG 4.1.3) — announces the loaded count once. */}
      <LiveRegion visuallyHidden data-testid="activity-live-region">
        {announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </div>
  );
}
