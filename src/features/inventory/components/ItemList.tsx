import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Spinner } from '@/components/foundry';
import { PackageIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';
import { ItemCard } from './ItemCard';
import { ItemRow } from './ItemRow';

const VISUAL_CARD_MIN_WIDTH = 280;

/**
 * Virtualised item list (spec §2.1, §3). Pages from `useInventoryItems` are
 * flattened and rendered through @tanstack/react-virtual, so only on-screen rows
 * exist in the DOM even with 100,000+ items. In Visual density, items are grouped
 * into responsive multi-column virtual rows; in Data density, one item per row.
 * Reaching the end fetches the next page.
 */
export function ItemList({
  items,
  locations,
  density,
  locationName,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  items: readonly Item[];
  locations: readonly LocationWithCount[];
  density: LayoutDensity;
  locationName: (id: string) => string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const columns = useColumns(parentRef, density);

  const rowCount = Math.ceil(items.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (density === 'data' ? 60 : 232),
    overscan: 6,
  });

  // Re-measure when the layout mode or column count changes.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [density, columns, virtualizer]);

  // Infinite loading: fetch the next page as the tail scrolls into view.
  const virtualRows = virtualizer.getVirtualItems();
  const lastRow = virtualRows[virtualRows.length - 1];
  useEffect(() => {
    if (!lastRow) return;
    if (lastRow.index >= rowCount - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [lastRow, rowCount, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto pr-1">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const start = virtualRow.index * columns;
          const rowItems = items.slice(start, start + columns);
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
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
                    />
                  ) : (
                    <ItemCard
                      key={item.id}
                      item={item}
                      locations={locations}
                      locationName={locationName(item.locationId)}
                    />
                  ),
                )}
              </div>
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
