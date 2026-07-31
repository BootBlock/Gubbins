/**
 * ActivityFeedScreen — the global activity feed (Phase 80, Wave 3 #6; second lane issue #693).
 *
 * Folds **every** ledger event across the whole inventory into one chronological, newest-first
 * stream. Read-only; reuses the Phase-52 pure `describeHistoryEntry` seam for each row and the
 * Phase-37 absolute-index virtualised window (`list-window.ts`), so the feed stays light against
 * 100,000+ rows. A filter chip row narrows the stream (filtered in SQL so pagination stays
 * correct).
 *
 * **Two lanes, one screen (issue #693).** A subject switch chooses between the **Items** ledger
 * (`item_history`) and the **Locations** one (`location_history`). The location lane exists
 * because a `location_history` row outlives the location it describes — deliberately, so a
 * deletion stays a fact — while the only other reader is the History tab on the location editor,
 * which a deleted location no longer has. The entries that matter most were the ones nothing could
 * show. They belong on a general surface for exactly that reason: there is nothing left to
 * navigate *from*.
 *
 * The lanes are **switched between, not interleaved**. A genuine chronological merge of the two
 * ledgers means either a `UNION ALL` across two tables with different row shapes or a client-side
 * merge, and either has to re-solve offset pagination and the combined row count — a far larger
 * change than the gap warrants. Switching gets a reader everything the deleted-location case
 * needs, and leaves the merge available later.
 *
 * The feed honours the app-wide **"Paginate long lists"** preference (issue #20): with it on, the
 * stream is shown as discrete numbered pages (a plain list plus a page control at the foot)
 * instead of the default virtualised infinite scroll. Both lanes inherit that, the export control
 * and the chip row from the one screen rather than growing a second copy of each.
 *
 * Accessibility (§3 WCAG 4.1.3): an always-mounted `<LiveRegion>` announces the loaded count once
 * loading settles (Phase 63), and re-announces when the lane changes — switching subject is
 * exactly when a screen-reader user needs telling what is now on screen. The screen carries
 * `id={MAIN_CONTENT_ID}` for the skip-to-content link (Phase 40).
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  LiveRegion,
  MAIN_CONTENT_ID,
  PageContainer,
  PageHeader,
  Pagination,
  SegmentedRadioGroup,
  Spinner,
  Surface,
  pageCount,
} from '@/components/foundry';
import { HistoryIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import type { Formatters } from '@/lib/format';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { listRowCount, resolveListRow } from '@/features/inventory/list-window';
import { describeHistoryEntry, HISTORY_TONE_BADGE } from '@/features/inventory/history-format';
import {
  describeLocationHistoryEntry,
  locationHistoryActionLabel,
} from '@/features/inventory/location-history-format';
import { useT } from '@/features/i18n';
import type { TypedTranslator } from '@/features/i18n';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { exportEveryPage } from '@/features/export/export-every-page';
import {
  LOCATION_HISTORY_ACTIONS,
  type ActivityFeedEntry,
  type LocationHistoryAction,
  type LocationHistoryEntry,
} from '@/db/repositories';
import { activityExportFilename, buildActivityExport } from './activity-export';
import { buildLocationActivityExport, locationActivityExportFilename } from './location-activity-export';
import { ACTIVITY_KINDS, ACTIVITY_KIND_LABEL, actionsForKinds, type ActivityKind } from './activity-kind';
import {
  readActivityFeedPage,
  readLocationActivityFeedPage,
  useActivityFeed,
  useActivityFeedCount,
  useActivityPage,
  useLocationActivityFeed,
  useLocationActivityFeedCount,
  useLocationActivityPage,
} from './queries';

/** Estimated entry height — also the height of a not-yet-resident placeholder. */
const ROW_HEIGHT = 64;

/** Which ledger the screen is showing. */
type ActivityLane = 'items' | 'locations';

// ---------------------------------------------------------------------------
// Filter chips — a token-styled toggle row (mirrors the agenda's kind filter)
// ---------------------------------------------------------------------------

/** One toggleable chip: the value it filters on, and what it is called. */
interface FilterChip<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * The chip row both lanes filter through. Generic over the filter value because the two lanes
 * filter by different things — the item lane by semantic *kind* (the §4 ledger has far more
 * actions than fit a chip each), the location lane by *action* directly (six of them, so folding
 * them into kinds would be a grouping that hides nothing).
 */
function ChipFilter<T extends string>({
  chips,
  enabled,
  onToggle,
  label,
  testIdPrefix,
}: {
  chips: readonly FilterChip<T>[];
  enabled: ReadonlySet<T>;
  onToggle: (value: T) => void;
  label: string;
  testIdPrefix: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-lg bg-secondary/60 p-0.5"
      role="group"
      aria-label={label}
    >
      {chips.map((chip) => {
        const active = enabled.has(chip.value);
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => onToggle(chip.value)}
            aria-pressed={active}
            data-testid={`${testIdPrefix}-${chip.value}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One feed entry per lane — shared by the virtualised and paginated views
// ---------------------------------------------------------------------------

function ActivityRow({ entry, fmt }: { entry: ActivityFeedEntry; fmt: Formatters }) {
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
                HISTORY_TONE_BADGE[view.tone],
              )}
            >
              {view.delta}
            </span>
          ) : null}
        </div>
        {view.detail ? <p className="truncate text-xs text-muted-foreground">{view.detail}</p> : null}
      </div>
      <time
        dateTime={new Date(entry.createdAt).toISOString()}
        className="shrink-0 text-[11px] text-muted-foreground/80"
      >
        {fmt.dateTime(entry.createdAt)}
      </time>
    </div>
  );
}

/**
 * One location activity entry (issue #693).
 *
 * Rendered through the same pure `describeLocationHistoryEntry` seam the editor's History tab
 * uses, so the lane and the tab can never disagree about what a `RE_PARENTED` entry is called.
 *
 * The location name is deliberately **plain text, not a link**. Half the point of this lane is the
 * entries about places that no longer exist, and offering a route to one would be an invitation to
 * nowhere; the name is also the one the location carried when the entry was written, so even for a
 * place that still exists it may no longer be what it is called. The row reads as what it is: a
 * past-tense record of something that happened.
 */
function LocationActivityRow({ entry, fmt }: { entry: LocationHistoryEntry; fmt: Formatters }) {
  const view = describeLocationHistoryEntry(entry);
  return (
    <div
      data-testid="location-activity-feed-entry"
      className="flex items-start gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0"
    >
      <HistoryIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-xs font-semibold text-foreground">{entry.locationName}</span>
          <span className="text-xs text-muted-foreground">{view.label}</span>
        </div>
        {view.detail ? <p className="truncate text-xs text-muted-foreground">{view.detail}</p> : null}
      </div>
      <time
        dateTime={new Date(entry.createdAt).toISOString()}
        className="shrink-0 text-[11px] text-muted-foreground/80"
      >
        {fmt.dateTime(entry.createdAt)}
      </time>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list body — one copy of the read-mode machinery, shared by both lanes
// ---------------------------------------------------------------------------

/** The infinite (virtualised) mode's window state — inert while paginating. */
interface InfiniteWindow {
  /** Absolute index of the first resident entry — non-zero once front pages are trimmed. */
  readonly firstItemIndex: number;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => void;
  readonly hasPreviousPage: boolean;
  readonly isFetchingPreviousPage: boolean;
  readonly fetchPreviousPage: () => void;
}

/** The discrete-pagination mode's page state (issue #20) — inert while scrolling infinitely. */
interface PageControl {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  readonly pageSize: number;
  readonly onPageSizeChange: (size: number) => void;
  readonly totalItems: number;
}

/**
 * The feed body: either a plain list of one page with a page control below it, or the virtualised
 * window over the whole stream. Generic over the entry type so both lanes share **one** copy of
 * the virtualiser, the absolute indexing and the two scroll-refill effects — the alternative being
 * a second copy of all of it, which is exactly what putting the lanes on one screen avoids.
 *
 * `entries` is whichever set the current mode renders: the fetched page when paginated, the
 * resident window when not.
 */
function ActivityLaneList<T extends { readonly id: string }>({
  entries,
  renderRow,
  ariaLabel,
  paginated,
  infinite,
  pageControl,
  testIdPrefix,
}: {
  entries: readonly T[];
  renderRow: (entry: T) => ReactNode;
  ariaLabel: string;
  paginated: boolean;
  infinite: InfiniteWindow;
  pageControl: PageControl;
  testIdPrefix: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { firstItemIndex } = infinite;

  const rowCount = listRowCount(firstItemIndex, entries.length, 1);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualRows = virtualizer.getVirtualItems();

  // Infinite loading: fetch the next (older) page as the tail scrolls into view. Suppressed while
  // paginating (the infinite query is disabled then, so there is nothing to fetch).
  const lastRow = virtualRows[virtualRows.length - 1];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = infinite;
  useEffect(() => {
    if (paginated || !lastRow) return;
    if (lastRow.index >= rowCount - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [paginated, lastRow, rowCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Refill the prefix when scrolling back up into a trimmed-off region; absolute
  // indexing means the refetched page slots in above without moving the viewport.
  const firstRow = virtualRows[0];
  const { hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage } = infinite;
  useEffect(() => {
    if (paginated || !firstRow) return;
    if (firstRow.index < firstItemIndex && hasPreviousPage && !isFetchingPreviousPage) {
      fetchPreviousPage();
    }
  }, [paginated, firstRow, firstItemIndex, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage]);

  if (paginated) {
    return (
      <>
        <div
          data-testid={testIdPrefix}
          aria-label={ariaLabel}
          className="overflow-hidden rounded-lg border border-border bg-secondary/10"
        >
          {/*
           * A `Fragment` rather than a keyed wrapper element: the rows separate themselves with
           * `border-b … last:border-b-0`, and an element per row would make every row the last
           * child of its own wrapper — quietly erasing every separator.
           */}
          {entries.map((entry) => (
            <Fragment key={entry.id}>{renderRow(entry)}</Fragment>
          ))}
        </div>
        <Pagination
          page={pageControl.page}
          pageCount={pageControl.pageCount}
          onPageChange={pageControl.onPageChange}
          pageSize={pageControl.pageSize}
          onPageSizeChange={pageControl.onPageSizeChange}
          pageSizeOptions={PAGE_SIZE_PRESETS}
          minPageSize={PAGE_SIZE_BOUNDS.min}
          maxPageSize={PAGE_SIZE_BOUNDS.max}
          totalItems={pageControl.totalItems}
          data-testid={`${testIdPrefix}-pagination`}
        />
      </>
    );
  }

  return (
    <div
      ref={parentRef}
      data-testid={testIdPrefix}
      aria-label={ariaLabel}
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
              {entry ? renderRow(entry) : <div style={{ height: ROW_HEIGHT }} aria-hidden />}
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
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

/** The item lane's chips: semantic kinds, since the item ledger has far more actions than fit. */
function itemChips(): readonly FilterChip<ActivityKind>[] {
  return ACTIVITY_KINDS.map((kind) => ({ value: kind, label: ACTIVITY_KIND_LABEL[kind] }));
}

/**
 * The location lane's chips: one per action.
 *
 * The labels come from the same pure seam the rows render through rather than from the catalog, so
 * a chip and the entries it selects always use the identical word — one source for "Moved", not
 * two that can drift.
 */
function locationChips(): readonly FilterChip<LocationHistoryAction>[] {
  return LOCATION_HISTORY_ACTIONS.map((action) => ({
    value: action,
    label: locationHistoryActionLabel(action),
  }));
}

export function ActivityFeedScreen() {
  const fmt = useFormatters();
  const t = useT();

  const [lane, setLane] = useState<ActivityLane>('items');

  // App-wide list pagination (issue #20). The feed has no grouped/visualisation modes, so the
  // preference alone decides: on → discrete pages, off → the virtualised infinite scroll.
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  const [page, setPage] = useState(1);

  /**
   * Switch subject, resetting the page in the **same** update rather than in an effect.
   *
   * An effect would run a render too late: the lane would have already flipped with the old page
   * number still set, so a reader on page 3 of the item ledger would fire a throwaway read for
   * page 3 of the location one — and watch its empty state flash if that ledger is shorter.
   */
  const changeLane = (next: ActivityLane) => {
    setLane(next);
    setPage(1);
  };

  // Every filter enabled by default; toggling a chip narrows the lane. Each lane keeps its own
  // selection, so switching subject and coming back doesn't silently reset what you were looking
  // at. When everything is enabled the resolved list covers all actions, so `undefined` is passed
  // and the repository skips the WHERE clause (the common "show everything" path).
  const [enabledKinds, setEnabledKinds] = useState<Set<ActivityKind>>(() => new Set(ACTIVITY_KINDS));
  const [enabledLocationActions, setEnabledLocationActions] = useState<Set<LocationHistoryAction>>(
    () => new Set(LOCATION_HISTORY_ACTIONS),
  );

  const toggleKind = (kind: ActivityKind) => setEnabledKinds((prev) => toggled(prev, kind));
  const toggleLocationAction = (action: LocationHistoryAction) =>
    setEnabledLocationActions((prev) => toggled(prev, action));

  const itemActions = useMemo(
    () => (enabledKinds.size === ACTIVITY_KINDS.length ? undefined : actionsForKinds(enabledKinds)),
    [enabledKinds],
  );
  const locationActions = useMemo(
    () =>
      enabledLocationActions.size === LOCATION_HISTORY_ACTIONS.length
        ? undefined
        : LOCATION_HISTORY_ACTIONS.filter((action) => enabledLocationActions.has(action)),
    [enabledLocationActions],
  );

  // Both lanes' reads are declared unconditionally (hooks must be), and gated so only the lane on
  // screen — and only its current read mode — ever queries. The other three stay idle.
  const showItems = lane === 'items';
  const itemFeed = useActivityFeed(itemActions, showItems && !paginated);
  const itemPageQuery = useActivityPage(itemActions, page, defaultPageSize, showItems && paginated);
  const itemCountQuery = useActivityFeedCount(itemActions, showItems && paginated);

  const locationFeed = useLocationActivityFeed(locationActions, !showItems && !paginated);
  const locationPageQuery = useLocationActivityPage(
    locationActions,
    page,
    defaultPageSize,
    !showItems && paginated,
  );
  const locationCountQuery = useLocationActivityFeedCount(locationActions, !showItems && paginated);

  // Each lane's rows stay separately typed — the two ledgers have different row shapes, and a
  // union of the two queries would lose that. Only scalars (counts, flags) are selected by lane.
  const itemPages = itemFeed.data?.pages ?? [];
  const itemEntries = paginated ? (itemPageQuery.data?.rows ?? []) : itemPages.flatMap((p) => p.rows);
  const locationPages = locationFeed.data?.pages ?? [];
  const locationEntries = paginated
    ? (locationPageQuery.data?.rows ?? [])
    : locationPages.flatMap((p) => p.rows);

  const entryCount = showItems ? itemEntries.length : locationEntries.length;
  const isLoading = paginated
    ? (showItems ? itemPageQuery : locationPageQuery).isLoading
    : (showItems ? itemFeed : locationFeed).isLoading;
  const isError = paginated
    ? (showItems ? itemPageQuery : locationPageQuery).isError
    : (showItems ? itemFeed : locationFeed).isError;
  const totalItems = (showItems ? itemCountQuery : locationCountQuery).data ?? 0;
  const totalPages = pageCount(totalItems, defaultPageSize);
  // Absolute index of the first resident entry — non-zero once front pages are trimmed. Zero while
  // paginating, where the list renders one fetched page rather than a window.
  const firstItemIndex = paginated ? 0 : ((showItems ? itemPages : locationPages)[0]?.offset ?? 0);

  const infinite = useInfiniteWindow(showItems ? itemFeed : locationFeed, firstItemIndex);
  const pageControl: PageControl = {
    page,
    pageCount: totalPages,
    onPageChange: setPage,
    pageSize: defaultPageSize,
    onPageSizeChange: setDefaultPageSize,
    totalItems,
  };

  // Reset to page 1 whenever the filter or the page size changes, so a narrowing filter can't
  // strand the user on an out-of-range page. (The lane switch resets in its own handler rather
  // than here — see `changeLane`.)
  useEffect(() => {
    setPage(1);
  }, [itemActions, locationActions, defaultPageSize]);
  // Clamp back into range if the feed shrinks below the current page.
  useEffect(() => {
    if (paginated && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [paginated, totalPages, page]);

  // Announce the loaded count once the lane's first load settles (WCAG 4.1.3) — once per lane, so
  // switching subject says what is now on screen rather than leaving the previous count standing.
  const [announcement, setAnnouncement] = useState('');
  const announcedLaneRef = useRef<ActivityLane | null>(null);
  useEffect(() => {
    if (isLoading || announcedLaneRef.current === lane) return;
    announcedLaneRef.current = lane;
    setAnnouncement(
      entryCount === 0
        ? t('activity.announce.empty')
        : t('activity.announce.count', { vars: { count: entryCount } }),
    );
  }, [isLoading, entryCount, lane, t]);

  const noneEnabled = showItems ? enabledKinds.size === 0 : enabledLocationActions.size === 0;

  return (
    <PageContainer>
      <PageHeader
        icon={<HistoryIcon />}
        title={t('activity.title')}
        actions={
          /*
           * The export re-reads the current lane under its current filter rather than serialising
           * the rows on screen: those are one page when paginated and a trimmed virtual window
           * otherwise, so the file would be arbitrarily short. The ledgers are the one list here
           * that can genuinely outgrow the read-everything ceiling, hence the truncation notice.
           */
          showItems ? (
            <TabularExportMenu
              build={(format) =>
                exportEveryPage(
                  readActivityFeedPage(itemActions),
                  (rows) => buildActivityExport(format, rows),
                  t('export.list.truncated'),
                )
              }
              filename={activityExportFilename}
              triggerLabel={t('export.list.trigger')}
              menuLabel={t('export.activity.menuLabel')}
              toastHeading={t('export.activity.toast')}
              disabled={isLoading || entryCount === 0}
              testIdPrefix="export-activity"
            />
          ) : (
            <TabularExportMenu
              build={(format) =>
                exportEveryPage(
                  readLocationActivityFeedPage(locationActions),
                  (rows) => buildLocationActivityExport(format, rows),
                  t('export.list.truncated'),
                )
              }
              filename={locationActivityExportFilename}
              triggerLabel={t('export.list.trigger')}
              menuLabel={t('export.locationActivity.menuLabel')}
              toastHeading={t('export.locationActivity.toast')}
              disabled={isLoading || entryCount === 0}
              testIdPrefix="export-location-activity"
            />
          )
        }
      />

      <p className="text-sm text-muted-foreground">
        {showItems ? t('activity.items.blurb') : t('activity.locations.blurb')}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedRadioGroup<ActivityLane>
          options={[
            { value: 'items', label: t('activity.lane.items') },
            { value: 'locations', label: t('activity.lane.locations') },
          ]}
          value={lane}
          onChange={changeLane}
          label={t('activity.lane.label')}
          testIdPrefix="activity-lane"
        />
        {showItems ? (
          <ChipFilter
            chips={itemChips()}
            enabled={enabledKinds}
            onToggle={toggleKind}
            label={t('activity.filter.kind.label')}
            testIdPrefix="activity-filter"
          />
        ) : (
          <ChipFilter
            chips={locationChips()}
            enabled={enabledLocationActions}
            onToggle={toggleLocationAction}
            label={t('activity.filter.action.label')}
            testIdPrefix="location-activity-filter"
          />
        )}
      </div>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-col gap-4 outline-none"
        data-testid="activity-main"
      >
        {isLoading && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {isError && !isLoading && (
          <Surface className="p-6 text-center text-sm text-destructive">{t('activity.error')}</Surface>
        )}

        {!isLoading && !isError && entryCount === 0 && (
          <Surface className="flex flex-col items-center gap-3 p-12 text-center">
            <HistoryIcon className="size-10 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">{t('activity.empty.title')}</p>
            <p className="text-sm text-muted-foreground">{emptyBody(t, showItems, noneEnabled)}</p>
          </Surface>
        )}

        {/*
         * One list body per lane, each in its own JSX slot rather than one slot switching between
         * two element types. React reconciles children positionally, so a lane change unmounts one
         * slot and mounts the other — which is what discards the virtualiser's scroll offset. Left
         * in one slot it would persist, scrolling a stream of a different length to wherever the
         * previous lane happened to be.
         */}
        {!isLoading && !isError && entryCount > 0 && showItems && (
          <ActivityLaneList
            entries={itemEntries}
            renderRow={(entry) => <ActivityRow entry={entry} fmt={fmt} />}
            ariaLabel={t('activity.feed.label')}
            paginated={paginated}
            infinite={infinite}
            pageControl={pageControl}
            testIdPrefix="activity-feed"
          />
        )}

        {!isLoading && !isError && entryCount > 0 && !showItems && (
          <ActivityLaneList
            entries={locationEntries}
            renderRow={(entry) => <LocationActivityRow entry={entry} fmt={fmt} />}
            ariaLabel={t('activity.locations.feed.label')}
            paginated={paginated}
            infinite={infinite}
            pageControl={pageControl}
            testIdPrefix="location-activity-feed"
          />
        )}
      </main>

      {/* Always-mounted live region (WCAG 4.1.3) — announces the loaded count per lane. */}
      <LiveRegion visuallyHidden data-testid="activity-live-region">
        {announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </PageContainer>
  );
}

/**
 * Just enough of a `useInfiniteQuery` result to drive the scroll-refill effects. Structural rather
 * than the concrete react-query type so one helper serves both lanes, whose page rows differ.
 */
interface InfiniteFeedLike {
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => unknown;
  readonly hasPreviousPage: boolean;
  readonly isFetchingPreviousPage: boolean;
  readonly fetchPreviousPage: () => unknown;
}

/**
 * Project the active lane's infinite query onto the window the list body consumes.
 *
 * **Memoised**, and load-bearingly so: the list body's two scroll-refill effects depend on this
 * object's callbacks, and react-query's own `fetchNextPage` is referentially stable. Rebuilding
 * the wrapper every render would re-run both effects on every render instead of when the window
 * actually moves.
 */
function useInfiniteWindow(feed: InfiniteFeedLike, firstItemIndex: number): InfiniteWindow {
  const {
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    hasPreviousPage,
    isFetchingPreviousPage,
    fetchPreviousPage,
  } = feed;
  return useMemo(
    () => ({
      firstItemIndex,
      hasNextPage,
      isFetchingNextPage,
      fetchNextPage: () => void fetchNextPage(),
      hasPreviousPage,
      isFetchingPreviousPage,
      fetchPreviousPage: () => void fetchPreviousPage(),
    }),
    [
      firstItemIndex,
      hasNextPage,
      isFetchingNextPage,
      fetchNextPage,
      hasPreviousPage,
      isFetchingPreviousPage,
      fetchPreviousPage,
    ],
  );
}

/** Toggle `value`'s membership in a new copy of `set` (chip state is immutable per render). */
function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * The empty state's second line. "Nothing matches your filter" and "nothing has happened yet" are
 * different situations and a reader can only act on one of them, so they say different things.
 */
function emptyBody(t: TypedTranslator, showItems: boolean, noneEnabled: boolean): string {
  if (noneEnabled) {
    return showItems ? t('activity.empty.noKinds') : t('activity.locations.empty.noActions');
  }
  return showItems ? t('activity.items.empty.body') : t('activity.locations.empty.body');
}
