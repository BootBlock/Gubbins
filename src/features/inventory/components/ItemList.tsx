import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/foundry';
import { PackageIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';
import { inventoryEmptyState, type InventoryEmptyContext } from '../inventory-empty-state';
import { listRowCount, resolveListRow } from '../list-window';
import { ItemCard } from './ItemCard';
import { ItemRow } from './ItemRow';
import { ItemTableHeader, ItemTableRow } from './ItemTable';
import { tableFieldColumns, tableGridColumns } from './item-table-columns';
import { SubLocationNav } from './SubLocationNav';
import { cardFieldProps, type CardFieldsListContext } from './card-fields-render';
import type { ItemSelection } from './inventory-ui';

const VISUAL_CARD_MIN_WIDTH = 280;

/** Estimated row height per density — also the height of a not-yet-resident placeholder. */
const ROW_HEIGHT = { data: 60, visual: 232, table: 48 } as const;

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
  const { columns, scrollRef: parentRef, setScrollEl } = useColumns(density);
  const isTable = density === 'table';

  // The table view's columns are the configured card fields (backlog E1) with Name + Stock
  // bookending them; the header and every row share one `grid-template-columns` so they align.
  const selecting = selection != null;
  const tableColumns = useMemo(
    () => tableFieldColumns(cardFields.order, cardFields.customFields),
    [cardFields.order, cardFields.customFields],
  );
  const tableColumnIds = useMemo(() => tableColumns.map((c) => c.id), [tableColumns]);
  const tableGrid = useMemo(
    () => tableGridColumns(tableColumns.length, selecting),
    [tableColumns.length, selecting],
  );

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
  const scroller = (
    <div
      ref={setScrollEl}
      data-testid="item-list-scroll"
      // The Table view keeps its header above (a sibling) rather than scrolling with the body,
      // so its scroll box drops the top padding the card/row views use for hover-glow room.
      role={isTable ? 'presentation' : undefined}
      className={cn('min-h-0 flex-1 overflow-auto px-4 pb-4', isTable ? 'pt-0' : 'pt-2')}
    >
      <div
        role={isTable ? 'presentation' : undefined}
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualRows.map((virtualRow) => {
          const { start, end, resident } = resolveListRow(
            virtualRow.index,
            columns,
            firstItemIndex,
            items.length,
          );
          const rowItems = resident ? items.slice(start, end) : [];
          const firstItem = rowItems[0];
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              role={isTable ? 'presentation' : undefined}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {resident ? (
                isTable ? (
                  firstItem ? (
                    <ItemTableRow
                      item={firstItem}
                      locations={locations}
                      locationName={locationName(firstItem.locationId)}
                      locationColorClass={locationColorClass?.(firstItem.locationId)}
                      locationTintClass={locationTintClass?.(firstItem.locationId)}
                      selection={selection}
                      selected={selectedIds?.has(firstItem.id) ?? false}
                      gridTemplate={tableGrid}
                      columnIds={tableColumnIds}
                      // Header is row 1; the virtual row's absolute index sits at index + 2.
                      ariaRowIndex={virtualRow.index + 2}
                      categoryName={cardFields.categoryName(firstItem.categoryId)}
                      customFields={cardFields.customFields}
                      customValues={cardFields.values?.get(firstItem.id)}
                    />
                  ) : null
                ) : (
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
                )
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

  if (isTable) {
    // A spreadsheet table: a fixed header of column labels above the virtualised, scrolling body.
    // The intermediate scroll/relative/absolute wrappers are `role="presentation"` so the rows
    // (`role="row"`) re-parent to this `role="table"` for assistive tech.
    return (
      <div
        role="table"
        aria-label="Inventory items"
        // Absolute row span (header + every virtual row), matching the absolute `aria-rowindex`
        // each row carries — so a front-trimmed page at 100k+ scale doesn't under-count.
        aria-rowcount={rowCount + 1}
        className="flex min-h-0 flex-1 flex-col px-4"
      >
        <ItemTableHeader columns={tableColumns} selecting={selecting} gridTemplate={tableGrid} />
        <div role="presentation" className="-mx-4 min-h-0 flex-1">
          {scroller}
        </div>
      </div>
    );
  }

  return scroller;
}

/**
 * Responsive column count: 1 for Data density, width-derived for Visual.
 *
 * The scroll element is tracked in **state** (via {@link setScrollEl}, a callback ref) rather
 * than read from a plain ref, so a scroller that mounts *after* this component's first render
 * still triggers a measure. That late mount is exactly the first-item case: the list renders its
 * empty banner first (no scroll container exists yet), then the container appears once the first
 * item arrives. A ref-only measure ran once — while the container was still absent — attached no
 * observer, and never re-ran, so the lone card rendered stretched full-width until some unrelated
 * remount happened to heal it. Keying the layout effect off the element makes it (re)measure and
 * (re)observe whenever the scroller attaches, so the grid is correct on first paint.
 *
 * Returns the merged `scrollRef` (for the virtualizer's `getScrollElement`) alongside the
 * `setScrollEl` callback ref the scroll container binds.
 */
function useColumns(density: LayoutDensity): {
  columns: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  setScrollEl: (node: HTMLDivElement | null) => void;
} {
  const [columns, setColumns] = useState(1);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollEl = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setEl(node);
  }, []);

  useLayoutEffect(() => {
    // Data and Table are one item per row; only Visual packs multiple cards per virtual row.
    if (density !== 'visual') {
      setColumns(1);
      return;
    }
    if (!el) return;
    const update = () => {
      setColumns(Math.max(1, Math.floor(el.clientWidth / VISUAL_CARD_MIN_WIDTH)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, density]);

  return { columns, scrollRef, setScrollEl };
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
