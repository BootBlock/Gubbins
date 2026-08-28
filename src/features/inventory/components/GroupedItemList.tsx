import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { Button, Reveal, Spinner } from '@/components/foundry';
import { ChevronRightIcon, PackageIcon } from '@/components/icons';
import type {
  Item,
  ItemStatusFilter,
  LocationTreeNode,
  LocationWithCount,
  LowStockThresholds,
} from '@/db/repositories';
import { DEFAULT_PAGE_SIZE } from '@/db/repositories/constants';
import { useT } from '@/features/i18n';
import { useLayoutStore, type ItemDensity } from '@/state/stores/useLayoutStore';
import { pruneArchivedTree } from '../location-tree';
import { useItemFieldValues } from '../categories';
import { useItemsTags } from '../tags';
import { useLocationSectionItems } from '../queries';
import { LIST_ROW_HEIGHT, listRowCount, resolveListRow } from '../list-window';
import {
  densityColumnWidth,
  densityGridStyle,
  densitySectionClass,
  densitySectionGridStyle,
  densityVirtualRowClass,
} from '../density-layout';
import { toItemSort } from '../sorting';
import { LocationIcon } from './LocationIcon';
import { ItemTableHeader, ItemTableRow } from './ItemTable';
import { tableFieldColumns, tableGridColumns } from './item-table-columns';
import { ItemPresentation } from './ItemPresentation';
import { type CardFieldsListContext } from './card-fields-render';
import type { CardFieldsConfigBundle } from './useCardFieldsConfig';
import type { ItemSelection } from './inventory-ui';

/**
 * Item count above which a section renders through the virtualiser rather than as plain DOM
 * (issue #171). A section that fits in its first page is small enough to mount outright — that
 * is the ordinary browse-by-area case, and plain DOM keeps it simple. Past a page, the section
 * is a location holding hundreds or thousands of items, where mounting every card (each with its
 * own dialogs, mutations and thumbnail BLOB) is what makes the grouped view fall over. One page
 * is the threshold because it is also the point at which the query starts trimming pages off the
 * front, which only the virtualiser's absolute indexing can render correctly.
 */
const SECTION_VIRTUALIZE_THRESHOLD = DEFAULT_PAGE_SIZE;

interface SharedSectionProps {
  readonly density: ItemDensity;
  /** Free-text search applied within each section (empty = no text filter). */
  readonly search: string;
  readonly includeInactive: boolean;
  /** Attribute facets applied within each section (undefined = none). */
  readonly categoryId?: string;
  readonly tagIds?: readonly string[];
  /** Derived-status "attention" filters applied within each section (undefined = none). */
  readonly status?: readonly ItemStatusFilter[];
  readonly lowStockThresholds?: LowStockThresholds;
  readonly expirySoonWindowDays?: number;
  readonly locations: readonly LocationWithCount[];
  readonly locationName: (id: string) => string;
  readonly locationColorClass?: (id: string) => string | undefined;
  /** Resolve a location id to its card/row edge-tint class (visual-flair F10), if coloured. */
  readonly locationTintClass?: (id: string) => string | undefined;
  readonly selection?: ItemSelection;
  readonly selectedIds?: ReadonlySet<string>;
  /** Configurable card-field config (backlog E1); each section fetches its own custom values. */
  readonly cardFieldsConfig: CardFieldsConfigBundle;
}

/**
 * The "By location" arrangement of the inventory grid (spec §3 grouping axis): the
 * location hierarchy rendered as **nested, collapsible sections**, each showing the items
 * that sit *directly* in that location (children are their own nested subsections, so an
 * item is never double-counted). Sections load their items lazily — the query fires only
 * once a section is expanded — so opening the view costs nothing until the user drills in.
 *
 * This is the grouped counterpart to the flat, virtualised {@link ItemList}. A small section
 * renders as plain DOM, which suits a browse-by-area workflow; once a section grows past its
 * first page it virtualises its body against this view's shared scroll box, so a location
 * holding tens of thousands of items costs the same handful of mounted cards as any other.
 */
export function GroupedItemList({
  tree,
  ...shared
}: SharedSectionProps & { readonly tree: readonly LocationTreeNode[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Archived branches are hidden here just as they are in the sidebar — the grouped grid
  // and the tree show the same set of locations.
  const visibleTree = useMemo(() => pruneArchivedTree(tree as LocationTreeNode[]), [tree]);

  // Expansion overrides keyed by location id; a missing id falls back to the depth
  // default (top-level sections open, deeper ones collapsed) — mirroring the sidebar's
  // baseline so the two feel consistent. Session-local: the grouped view is transient
  // enough that persisting this as well as the sidebar's would be noise.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isExpanded = useCallback((id: string, depth: number) => overrides[id] ?? depth === 1, [overrides]);
  const toggle = useCallback((id: string, depth: number) => {
    setOverrides((prev) => ({ ...prev, [id]: !(prev[id] ?? depth === 1) }));
  }, []);

  return (
    <div
      ref={scrollRef}
      data-testid="grouped-item-list"
      className="min-h-0 flex-1 space-y-1 overflow-auto px-1 pt-2"
    >
      {/* Each top-level location section rises in on the shared `animate-rise` entrance the
          first time it scrolls into this box (staggered by position). Only the top-level
          sections are wrapped — nested subsections already play `animate-swap-in-slow` on expand,
          and the virtualised flat ItemList must never entrance-animate (its rows recycle on
          scroll). The observer clips against this `overflow-auto` box's viewport slice, so a
          below-the-fold section reveals as it's scrolled up; reduced-motion / no-observer
          renders every section visible from first paint. */}
      {visibleTree.map((node, i) => (
        <Reveal key={node.id} index={i}>
          <LocationSection
            node={node}
            depth={1}
            isExpanded={isExpanded}
            onToggle={toggle}
            scrollRef={scrollRef}
            {...shared}
          />
        </Reveal>
      ))}
    </div>
  );
}

/**
 * One location's collapsible section (recursive). The header is a disclosure button
 * (`aria-expanded` / `aria-controls`); expanding it reveals this location's own items
 * followed by its child locations as nested sections, indented by depth.
 */
function LocationSection({
  node,
  depth,
  isExpanded,
  onToggle,
  scrollRef,
  ...shared
}: SharedSectionProps & {
  readonly node: LocationTreeNode;
  readonly depth: number;
  readonly isExpanded: (id: string, depth: number) => boolean;
  readonly onToggle: (id: string, depth: number) => void;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const expanded = isExpanded(node.id, depth);
  const panelId = `location-section-${node.id}`;
  const hasChildren = node.children.length > 0;
  const colorClass = shared.locationColorClass?.(node.id);

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(node.id, depth)}
        aria-expanded={expanded}
        aria-controls={panelId}
        data-testid={`location-section-header-${node.id}`}
        style={{ paddingLeft: `${(depth - 1) * 1.25 + 0.5}rem` }}
        className="flex w-full items-center gap-2 rounded-lg py-2 pr-3 text-left transition-colors hover:bg-secondary/50"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <LocationIcon
          icon={node.icon}
          expanded={expanded && hasChildren}
          className={cn('size-4 shrink-0', colorClass ?? 'text-muted-foreground')}
        />
        <span className={cn('truncate text-sm font-medium', colorClass)}>{node.name}</span>
        <span className="shrink-0 tabular-nums text-xs text-item-count">
          {node.capacity != null ? `${node.itemCount} / ${node.capacity}` : node.itemCount}
        </span>
      </button>

      {expanded ? (
        <div
          id={panelId}
          // A section mounts its content lazily on expand, so the entrance plays once as it
          // opens (fade-through-up, eased 50% longer per issue #475 so the items arrive a touch
          // more deliberately); the reduced-motion catch-all neutralises it.
          className="animate-swap-in-slow"
          style={{ paddingLeft: `${(depth - 1) * 1.25 + 0.5}rem` }}
        >
          <SectionItems locationId={node.id} isLeaf={!hasChildren} scrollRef={scrollRef} {...shared} />
          {hasChildren
            ? node.children.map((child) => (
                <LocationSection
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  isExpanded={isExpanded}
                  onToggle={onToggle}
                  scrollRef={scrollRef}
                  {...shared}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The items that sit directly in one location. Mounted only while its section is expanded,
 * so the query is lazy. Renders through the same {@link ItemCard} / {@link ItemRow} the
 * flat list uses, at the current density, and pages in more via a "Show more" button that
 * also auto-triggers when scrolled into view.
 */
function SectionItems({
  locationId,
  isLeaf,
  scrollRef,
  density,
  search,
  includeInactive,
  categoryId,
  tagIds,
  status,
  lowStockThresholds,
  expirySoonWindowDays,
  locations,
  locationName,
  locationColorClass,
  locationTintClass,
  selection,
  selectedIds,
  cardFieldsConfig,
}: SharedSectionProps & {
  readonly locationId: string;
  /** A leaf (childless) empty section shows a muted note; a parent just shows its children. */
  readonly isLeaf: boolean;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  // The ordering axis (issue #128) is read straight from the layout store rather than drilled
  // through the section tree: it is one global choice that every section obeys, and each section
  // owns its own query, so there is nothing for a parent to coordinate.
  const inventorySort = useLayoutStore((s) => s.inventorySort);
  const sort = useMemo(() => toItemSort(inventorySort), [inventorySort]);
  const filters = useMemo(
    () => ({
      locationId,
      includeInactive,
      ...(categoryId ? { categoryId } : {}),
      ...(tagIds && tagIds.length > 0 ? { tagIds } : {}),
      ...(search ? { search } : {}),
      ...(sort ? { sort } : {}),
      ...(status && status.length > 0 ? { status, lowStockThresholds, expirySoonWindowDays } : {}),
    }),
    [
      locationId,
      includeInactive,
      categoryId,
      tagIds,
      search,
      sort,
      status,
      lowStockThresholds,
      expirySoonWindowDays,
    ],
  );
  const query = useLocationSectionItems(filters);
  const items = useMemo<readonly Item[]>(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  // Absolute index of the first resident item — non-zero once the query has trimmed pages off
  // the front of a deeply-paged section, which the virtualised body renders around.
  const firstItemIndex = query.data?.pages[0]?.offset ?? 0;

  // Custom-field values for just this section's loaded items (backlog E1), and only for the
  // custom fields the cards draw (#560). Skipped entirely unless a custom field is actually
  // shown, so a section costs no extra query in the default configuration. The context bundles
  // the shared config with these per-section values.
  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const fieldValues = useItemFieldValues(itemIds, cardFieldsConfig.visibleCustomFieldIds);
  const tagValues = useItemsTags(itemIds, cardFieldsConfig.hasTagsField);
  const cardFields: CardFieldsListContext = {
    ...cardFieldsConfig,
    values: fieldValues.data,
    itemTags: tagValues.data,
  };

  // Auto-load the next page when the sentinel scrolls into view, using the grouped list's
  // own scroll box as the observer root; the button remains a keyboard/explicit fallback.
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, scrollRef]);

  if (query.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner />
      </div>
    );
  }

  if (items.length === 0) {
    // A parent with no direct items simply defers to its child sections; only a leaf needs
    // to say the section is genuinely empty so its open, contentless state doesn't puzzle.
    return isLeaf ? (
      <p className="flex items-center gap-1.5 py-1.5 pl-6 text-xs text-muted-foreground [&_svg]:size-3.5">
        <PackageIcon aria-hidden />
        No items here{search ? ' match your search' : ''}.
      </p>
    ) : null;
  }

  // Every section is its own list, so each one is named by its location — several sections are
  // open at once by default, and a run of identically-named lists gives assistive tech no way to
  // tell the Workshop list from the Garage one.
  const listLabel = t('inventory.list.sectionLabel', { vars: { location: locationName(locationId) } });

  // Past its first page a section is large enough that mounting every card is the problem the
  // flat list already solved (issue #171), so its body switches to the virtualiser. Trimmed-off
  // front pages force the same choice: only absolute indexing renders them without jumping.
  if (firstItemIndex > 0 || items.length > SECTION_VIRTUALIZE_THRESHOLD) {
    return (
      <div className="pb-2 pl-6">
        <VirtualSectionBody
          items={items}
          firstItemIndex={firstItemIndex}
          hasNextPage={hasNextPage}
          listLabel={listLabel}
          density={density}
          scrollRef={scrollRef}
          locations={locations}
          locationName={locationName}
          locationColorClass={locationColorClass}
          locationTintClass={locationTintClass}
          selection={selection}
          selectedIds={selectedIds}
          cardFields={cardFields}
          hasPreviousPage={query.hasPreviousPage}
          isFetchingPreviousPage={query.isFetchingPreviousPage}
          fetchPreviousPage={query.fetchPreviousPage}
        />
        <SectionPager
          locationId={locationId}
          sentinelRef={sentinelRef}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          fetchNextPage={fetchNextPage}
        />
      </div>
    );
  }

  // A section has no `COUNT(*)` of its own, so the loaded span is the whole set only once there
  // is no further page to fetch; otherwise say -1 (ARIA's "size unknown") rather than a total
  // that would grow as the user pages in more.
  const sectionSetSize = hasNextPage ? -1 : items.length;

  return (
    <div className="pb-2 pl-6">
      {density === 'table' ? (
        <SectionTable
          items={items}
          listLabel={listLabel}
          locations={locations}
          locationName={locationName}
          locationColorClass={locationColorClass}
          locationTintClass={locationTintClass}
          selection={selection}
          selectedIds={selectedIds}
          cardFields={cardFields}
        />
      ) : (
        <div
          role="list"
          aria-label={listLabel}
          className={densitySectionClass(density)}
          style={densitySectionGridStyle(density)}
        >
          {items.map((item, index) => (
            <ItemPresentation
              key={item.id}
              density={density}
              item={item}
              locations={locations}
              locationName={locationName}
              locationColorClass={locationColorClass}
              locationTintClass={locationTintClass}
              selection={selection}
              selected={selectedIds?.has(item.id) ?? false}
              ariaPosInSet={index + 1}
              ariaSetSize={sectionSetSize}
              cardFields={cardFields}
            />
          ))}
        </div>
      )}
      <SectionPager
        locationId={locationId}
        sentinelRef={sentinelRef}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        fetchNextPage={fetchNextPage}
      />
    </div>
  );
}

/**
 * A section's "Show more" pager. Doubles as the intersection-observer sentinel that auto-loads
 * the next page, with the button itself the keyboard/explicit fallback. Shared by the plain and
 * virtualised section bodies so both page in the same way.
 */
function SectionPager({
  locationId,
  sentinelRef,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  readonly locationId: string;
  readonly sentinelRef: React.RefObject<HTMLButtonElement | null>;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => void;
}) {
  if (!hasNextPage) return null;
  return (
    <div className="flex justify-center pt-3">
      <Button
        ref={sentinelRef}
        variant="outline"
        size="sm"
        onClick={() => void fetchNextPage()}
        disabled={isFetchingNextPage}
        data-testid={`location-section-more-${locationId}`}
      >
        {isFetchingNextPage ? <Spinner /> : null}
        {isFetchingNextPage ? 'Loading…' : 'Show more'}
      </Button>
    </div>
  );
}

/**
 * A large section's items, virtualised (issue #171). Only the rows near the viewport are mounted,
 * so a location holding thousands of items costs the same as one holding a dozen — the same
 * guarantee the flat {@link ItemList} gives, and it renders through the same leaf components at
 * the same estimated row heights, so a card looks identical flat or grouped.
 *
 * The one structural difference is that sections do **not** own a scroller each: they all scroll
 * inside the grouped view's single box, stacked with their headers and with each other. The
 * virtualizer is therefore pointed at that shared scroller and offset by this section's distance
 * from the top of its content (`scrollMargin`), and each row subtracts that same offset back out
 * when positioning itself — the standard way to virtualise one slice of a longer document.
 *
 * Rows are indexed in **absolute** space (see `../list-window`), so a page trimmed off the front
 * leaves the rows on screen exactly where they were; scrolling back up into the trimmed prefix
 * refetches it in place.
 */
function VirtualSectionBody({
  items,
  firstItemIndex,
  hasNextPage,
  listLabel,
  density,
  scrollRef,
  locations,
  locationName,
  locationColorClass,
  locationTintClass,
  selection,
  selectedIds,
  cardFields,
  hasPreviousPage,
  isFetchingPreviousPage,
  fetchPreviousPage,
}: {
  readonly items: readonly Item[];
  readonly firstItemIndex: number;
  /**
   * Whether the section has a further page to load — it decides whether the set size the rows
   * announce is the loaded span or "unknown" (issue #208).
   */
  readonly hasNextPage: boolean;
  /** This section's accessible name — "Items in <location>" (issue #208). */
  readonly listLabel: string;
  readonly density: ItemDensity;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly locations: readonly LocationWithCount[];
  readonly locationName: (id: string) => string;
  readonly locationColorClass?: (id: string) => string | undefined;
  readonly locationTintClass?: (id: string) => string | undefined;
  readonly selection?: ItemSelection;
  readonly selectedIds?: ReadonlySet<string>;
  readonly cardFields: CardFieldsListContext;
  readonly hasPreviousPage: boolean;
  readonly isFetchingPreviousPage: boolean;
  readonly fetchPreviousPage: () => void;
}) {
  const isTable = density === 'table';
  const bodyRef = useRef<HTMLDivElement>(null);
  const columns = useSectionColumns(bodyRef, density);
  const scrollMargin = useSectionScrollMargin(scrollRef, bodyRef);

  const rowCount = listRowCount(firstItemIndex, items.length, columns);
  // Matches the plain section body: the loaded span is the whole set only once no further page
  // remains; otherwise -1, ARIA's "size unknown".
  const setSize = hasNextPage ? -1 : firstItemIndex + items.length;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LIST_ROW_HEIGHT[density],
    overscan: 4,
    scrollMargin,
  });

  // Re-measure when the layout mode or column count changes.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [density, columns, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  // Refill the prefix when the user scrolls back up into a trimmed-off region; absolute
  // positioning means the refetched page slots in above without moving the viewport.
  const firstRow = virtualRows[0];
  useEffect(() => {
    if (!firstRow) return;
    if (firstRow.index * columns < firstItemIndex && hasPreviousPage && !isFetchingPreviousPage) {
      fetchPreviousPage();
    }
  }, [firstRow, columns, firstItemIndex, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage]);

  const selecting = selection != null;
  const {
    columns: tableColumns,
    columnIds: tableColumnIds,
    gridTemplate: tableGrid,
  } = useTableColumnModel(cardFields, selecting);

  const body = (
    <div
      ref={bodyRef}
      role={isTable ? 'presentation' : 'list'}
      aria-label={isTable ? undefined : listLabel}
      data-testid="location-section-virtual-body"
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
            // Positioning only — the row's items re-parent to the `table`/`list` above.
            role="presentation"
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
          >
            {!resident ? (
              // A row whose page was trimmed off the front and is being refilled.
              <div style={{ height: LIST_ROW_HEIGHT[density] }} aria-hidden />
            ) : // Compared against the literal rather than the hoisted `isTable`, so TypeScript
            // narrows `density` for the per-item fork in the last arm.
            density === 'table' ? (
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
                  tags={cardFields.itemTags?.get(firstItem.id)}
                />
              ) : null
            ) : (
              <div
                role="presentation"
                className={densityVirtualRowClass(density)}
                style={densityGridStyle(density, columns)}
              >
                {rowItems.map((item, column) => (
                  <ItemPresentation
                    key={item.id}
                    density={density}
                    item={item}
                    locations={locations}
                    locationName={locationName}
                    locationColorClass={locationColorClass}
                    locationTintClass={locationTintClass}
                    selection={selection}
                    selected={selectedIds?.has(item.id) ?? false}
                    ariaPosInSet={firstItemIndex + start + column + 1}
                    ariaSetSize={setSize}
                    cardFields={cardFields}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (!isTable) return body;

  // A spreadsheet table: the column header sits above the virtualised body, and the
  // intermediate wrappers are `role="presentation"` so the rows re-parent to this `role="table"`.
  return (
    <div role="table" aria-label={listLabel} aria-rowcount={rowCount + 1}>
      <ItemTableHeader columns={tableColumns} selecting={selecting} gridTemplate={tableGrid} />
      <div role="rowgroup">{body}</div>
    </div>
  );
}

/**
 * The Table view's column model for one section: the configured card fields, plus the ids and
 * the single `grid-template-columns` its header and every one of its rows share so they align.
 * Shared by the plain and virtualised section bodies — they show the same table, so they must
 * derive the same columns from the same config.
 */
function useTableColumnModel(cardFields: CardFieldsListContext, selecting: boolean) {
  const columns = useMemo(
    () => tableFieldColumns(cardFields.order, cardFields.customFields),
    [cardFields.order, cardFields.customFields],
  );
  const columnIds = useMemo(() => columns.map((c) => c.id), [columns]);
  const gridTemplate = useMemo(
    () => tableGridColumns(columns.length, selecting),
    [columns.length, selecting],
  );
  return { columns, columnIds, gridTemplate };
}

/**
 * Responsive column count for a virtualised section body: one item per row in Data and Table
 * density, width-derived in the multi-column modes so items pack the same way the flat list
 * packs them — at each mode's own minimum column width.
 */
function useSectionColumns(ref: React.RefObject<HTMLDivElement | null>, density: ItemDensity): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const minWidth = densityColumnWidth(density);
    if (minWidth === null) {
      setColumns(1);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setColumns(Math.max(1, Math.floor(el.clientWidth / minWidth)));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, density]);
  return columns;
}

/**
 * How far a section's body sits from the top of the grouped view's shared scroll content — the
 * `scrollMargin` its virtualizer needs, since every section scrolls in the one box rather than
 * owning a scroller each.
 *
 * The offset moves whenever anything above the section changes height: a sibling expanding or
 * collapsing, a section above paging in, a row above measuring taller than its estimate. Those
 * happen in components that don't re-render this one, so the measurement is refreshed after every
 * render *and* on scroll (it is scroll-invariant — the container's scroll offset is added back —
 * so a scroll simply provides a well-timed moment to re-check) and on viewport resize. The value
 * only enters state when it has actually moved, so re-measuring never loops.
 *
 * Reading the two rects forces layout, and scroll fires far faster than the screen paints, so the
 * listener coalesces into one measurement per frame — the render-time pass is already at a point
 * where layout is being computed anyway.
 */
function useSectionScrollMargin(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  bodyRef: React.RefObject<HTMLDivElement | null>,
): number {
  const [margin, setMargin] = useState(0);
  const measure = useCallback(() => {
    const body = bodyRef.current;
    const scroller = scrollRef.current;
    if (!body || !scroller) return;
    const next = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setMargin((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  }, [bodyRef, scrollRef]);

  useLayoutEffect(measure);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [measure, scrollRef]);

  return margin;
}

/**
 * A location section's items as a spreadsheet table — the grouped counterpart to the flat
 * {@link ItemList}'s Table view. A section that fits within its first page is its own small,
 * non-virtualised table (a larger one goes through {@link VirtualSectionBody} instead), sharing
 * the same column model and {@link ItemTableRow} so a Table-view row looks the same flat or grouped.
 */
function SectionTable({
  items,
  listLabel,
  locations,
  locationName,
  locationColorClass,
  locationTintClass,
  selection,
  selectedIds,
  cardFields,
}: {
  readonly items: readonly Item[];
  /** This section's accessible name — "Items in <location>" (issue #208). */
  readonly listLabel: string;
  readonly locations: readonly LocationWithCount[];
  readonly locationName: (id: string) => string;
  readonly locationColorClass?: (id: string) => string | undefined;
  readonly locationTintClass?: (id: string) => string | undefined;
  readonly selection?: ItemSelection;
  readonly selectedIds?: ReadonlySet<string>;
  readonly cardFields: CardFieldsListContext;
}) {
  const selecting = selection != null;
  const { columns, columnIds, gridTemplate } = useTableColumnModel(cardFields, selecting);
  return (
    <div role="table" aria-label={listLabel} aria-rowcount={items.length + 1}>
      <ItemTableHeader columns={columns} selecting={selecting} gridTemplate={gridTemplate} />
      <div role="rowgroup">
        {items.map((item, i) => (
          <ItemTableRow
            key={item.id}
            item={item}
            locations={locations}
            locationName={locationName(item.locationId)}
            locationColorClass={locationColorClass?.(item.locationId)}
            locationTintClass={locationTintClass?.(item.locationId)}
            selection={selection}
            selected={selectedIds?.has(item.id) ?? false}
            gridTemplate={gridTemplate}
            columnIds={columnIds}
            ariaRowIndex={i + 2}
            categoryName={cardFields.categoryName(item.categoryId)}
            customFields={cardFields.customFields}
            customValues={cardFields.values?.get(item.id)}
            tags={cardFields.itemTags?.get(item.id)}
          />
        ))}
      </div>
    </div>
  );
}
