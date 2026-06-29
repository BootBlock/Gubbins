import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Spinner } from '@/components/foundry';
import { PackageIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';
import { listRowCount, resolveListRow } from '../list-window';
import { ItemCard } from './ItemCard';
import { ItemRow } from './ItemRow';
import type { ItemSelection } from './inventory-ui';

const VISUAL_CARD_MIN_WIDTH = 280;

/** Estimated row height per density — also the height of a not-yet-resident placeholder. */
const ROW_HEIGHT = { data: 60, visual: 232 } as const;

/**
 * Virtualised item list (spec §2.1, §3). Pages from `useInventoryItems` are
 * flattened and rendered through @tanstack/react-virtual, so only on-screen rows
 * exist in the DOM even with 100,000+ items. In Visual density, items are grouped
 * into responsive multi-column virtual rows; in Data density, one item per row.
 * Reaching the end fetches the next page.
 */
export function ItemList({
  items,
  firstItemIndex,
  locations,
  density,
  locationName,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  hasPreviousPage,
  isFetchingPreviousPage,
  fetchPreviousPage,
  selection,
}: {
  items: readonly Item[];
  /** Absolute index of the first resident item — non-zero once front pages are trimmed. */
  firstItemIndex: number;
  locations: readonly LocationWithCount[];
  density: LayoutDensity;
  locationName: (id: string) => string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  fetchPreviousPage: () => void;
  selection?: ItemSelection;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const columns = useColumns(parentRef, density);

  // Absolute row count: the virtualizer indexes the full loaded-so-far span, so a
  // trimmed-off front page never shifts the rows the user is looking at.
  const rowCount = listRowCount(firstItemIndex, items.length, columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: 6,
  });

  // Re-measure when the layout mode or column count changes.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [density, columns, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  // Infinite loading: fetch the next page as the tail scrolls into view.
  const lastRow = virtualRows[virtualRows.length - 1];
  useEffect(() => {
    if (!lastRow) return;
    if (lastRow.index >= rowCount - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastRow, rowCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Refill the prefix when the user scrolls back up into a trimmed-off region. The
  // absolute layout means the refetched page slots in above without moving the view.
  const firstRow = virtualRows[0];
  useEffect(() => {
    if (!firstRow) return;
    if (firstRow.index * columns < firstItemIndex && hasPreviousPage && !isFetchingPreviousPage) {
      fetchPreviousPage();
    }
  }, [firstRow, columns, firstItemIndex, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage]);

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <div
      ref={parentRef}
      data-testid="item-list-scroll"
      className="min-h-0 flex-1 overflow-auto px-1 pt-2"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const { start, end, resident } = resolveListRow(
            virtualRow.index,
            columns,
            firstItemIndex,
            items.length,
          );
          const rowItems = resident ? items.slice(start, end) : [];
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {resident ? (
                <div
                  className={density === 'data' ? 'pb-1.5' : 'grid gap-4 pb-4'}
                  style={
                    density === 'data'
                      ? undefined
                      : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
                  }
                >
                  {rowItems.map((item) =>
                    density === 'data' ? (
                      <ItemRow
                        key={item.id}
                        item={item}
                        locations={locations}
                        locationName={locationName(item.locationId)}
                        selection={selection}
                      />
                    ) : (
                      <ItemCard
                        key={item.id}
                        item={item}
                        locations={locations}
                        locationName={locationName(item.locationId)}
                        selection={selection}
                      />
                    ),
                  )}
                </div>
              ) : (
                // A row whose page was trimmed off the front and is being refilled.
                <div style={{ height: ROW_HEIGHT[density] }} aria-hidden />
              )}
            </div>
          );
        })}
      </div>
      {isFetchingNextPage ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : null}
    </div>
  );
}

/** Responsive column count: 1 for Data density, width-derived for Visual. */
function useColumns(ref: React.RefObject<HTMLDivElement | null>, density: LayoutDensity): number {
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    if (density === 'data') {
      setColumns(1);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setColumns(Math.max(1, Math.floor(width / VISUAL_CARD_MIN_WIDTH)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, density]);

  return columns;
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground [&_svg]:size-7">
        <PackageIcon />
      </span>
      <div>
        <p className="font-medium">No items here yet</p>
        <p className="text-sm text-muted-foreground">Add your first item to start tracking.</p>
      </div>
    </div>
  );
}
