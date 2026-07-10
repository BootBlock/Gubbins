import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Spinner } from '@/components/foundry';
import { PackageIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';
import { inventoryEmptyState, type InventoryEmptyContext } from '../inventory-empty-state';
import { listRowCount, resolveListRow } from '../list-window';
import { ItemCard } from './ItemCard';
import { ItemRow } from './ItemRow';
import { SubLocationNav } from './SubLocationNav';
import { cardFieldProps, type CardFieldsListContext } from './card-fields-render';
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
  selectedLocationId,
  locationName,
  locationColorClass,
  locationTintClass,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  hasPreviousPage,
  isFetchingPreviousPage,
  fetchPreviousPage,
  childLocations,
  onSelectLocation,
  selection,
  selectedIds,
  cardFields,
  emptyContext,
}: {
  items: readonly Item[];
  /** Absolute index of the first resident item — non-zero once front pages are trimmed. */
  firstItemIndex: number;
  locations: readonly LocationWithCount[];
  density: LayoutDensity;
  /** The location currently filtering the list, or `null` for "All locations". */
  selectedLocationId?: string | null;
  locationName: (id: string) => string;
  /** Resolve a location id to its Tailwind text-colour class (its swatch), if any. */
  locationColorClass?: (id: string) => string | undefined;
  /** Resolve a location id to its card/row edge-tint class (visual-flair F10), if coloured. */
  locationTintClass?: (id: string) => string | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  hasPreviousPage: boolean;
  isFetchingPreviousPage: boolean;
  fetchPreviousPage: () => void;
  /**
   * The selected location's direct, active child locations. When the location holds no
   * items of its own but nests these, the empty state becomes a "drill down" grid of them
   * instead of a dead-end banner. Empty/omitted for the flat "All locations" view, a
   * childless location, or while a search/visual query is narrowing the list.
   */
  childLocations?: readonly LocationWithCount[];
  /** Navigate into a child location (select it in the sidebar). */
  onSelectLocation?: (id: string) => void;
  selection?: ItemSelection;
  /**
   * Ids of the currently-selected items. Held here rather than inside `selection` so
   * `selection` stays referentially stable across toggles: this list is not memoised, so
   * it re-renders on each toggle and derives a plain `selected` boolean per row — only the
   * one row whose boolean flipped then re-renders through its `memo`.
   */
  selectedIds?: ReadonlySet<string>;
  /** Configurable card fields (order + catalog + on-screen custom values), backlog E1. */
  cardFields: CardFieldsListContext;
  /**
   * The active narrowing (search / status chips / facets) so the empty banner can describe
   * *why* the list is empty from the user's point of view rather than always inviting a first
   * item. The location scope is derived from `selectedLocationId` + `locationName`.
   */
  emptyContext?: Pick<
    InventoryEmptyContext,
    'search' | 'visualSearch' | 'statusFilterCount' | 'categoryFilter' | 'tagFilterCount'
  >;
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
    // A location with no items of its own but with child locations drills down into them
    // rather than dead-ending on the empty banner (spec: inventory location view).
    if (childLocations && childLocations.length > 0 && onSelectLocation) {
      return (
        <SubLocationNav
          childLocations={childLocations}
          locations={locations}
          density={density}
          onSelect={onSelectLocation}
          locationColorClass={locationColorClass}
        />
      );
    }
    return (
      <EmptyState
        selectedLocationId={selectedLocationId}
        locationName={selectedLocationId ? locationName(selectedLocationId) : undefined}
        emptyContext={emptyContext}
      />
    );
  }

  // The scroller clips its overflow on both axes (it must, to scroll vertically), so the
  // horizontal padding doubles as the breathing room a card's hover lift-shadow
  // (`Surface interactive` → `hover:shadow-primary/10`) and highlight-flash ring need before the
  // clip — `px-1` (4px) cropped them into hard vertical edges at the sides. `px-4` + a matching
  // `pb-4` give the soft accent glow room to fall off; `pt-2` already covers the top.
  return (
    <div
      ref={parentRef}
      data-testid="item-list-scroll"
      className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-2"
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
                  {rowItems.map((item) => {
                    const selected = selectedIds?.has(item.id) ?? false;
                    return density === 'data' ? (
                      <ItemRow
                        key={item.id}
                        item={item}
                        locations={locations}
                        locationName={locationName(item.locationId)}
                        locationColorClass={locationColorClass?.(item.locationId)}
                        locationTintClass={locationTintClass?.(item.locationId)}
                        selection={selection}
                        selected={selected}
                        {...cardFieldProps(cardFields, item)}
                      />
                    ) : (
                      <ItemCard
                        key={item.id}
                        item={item}
                        locations={locations}
                        locationName={locationName(item.locationId)}
                        locationColorClass={locationColorClass?.(item.locationId)}
                        locationTintClass={locationTintClass?.(item.locationId)}
                        selection={selection}
                        selected={selected}
                        {...cardFieldProps(cardFields, item)}
                      />
                    );
                  })}
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

/**
 * The empty-state banner. Its wording adapts to how the user is viewing the list — a narrowed
 * "no matches" view names the search/filters rather than inviting a first item; an empty
 * system location explains how stock arrives there; otherwise the plain first-item invitation.
 * The copy decision lives in the pure {@link inventoryEmptyState} seam.
 */
function EmptyState({
  selectedLocationId,
  locationName,
  emptyContext,
}: {
  selectedLocationId?: string | null;
  locationName?: string;
  emptyContext?: Pick<
    InventoryEmptyContext,
    'search' | 'visualSearch' | 'statusFilterCount' | 'categoryFilter' | 'tagFilterCount'
  >;
}) {
  const { title, body } = inventoryEmptyState({
    ...emptyContext,
    locationId: selectedLocationId,
    locationName,
  });
  return (
    <div className="gubbins-accent-glow flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground [&_svg]:size-7">
        <PackageIcon />
      </span>
      <div className="max-w-md">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
