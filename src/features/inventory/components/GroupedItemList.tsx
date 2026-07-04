import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button, Spinner } from '@/components/foundry';
import { ChevronRightIcon, PackageIcon } from '@/components/icons';
import type { Item, LocationTreeNode, LocationWithCount } from '@/db/repositories';
import type { LayoutDensity } from '@/state/stores/useLayoutStore';
import { pruneArchivedTree } from '../location-tree';
import { useItemFieldValues } from '../categories';
import { useLocationSectionItems } from '../queries';
import { LocationKindIcon } from './LocationKindIcon';
import { ItemCard } from './ItemCard';
import { ItemRow } from './ItemRow';
import { cardFieldProps, type CardFieldsListContext } from './card-fields-render';
import type { CardFieldsConfigBundle } from './useCardFieldsConfig';
import type { ItemSelection } from './inventory-ui';

/**
 * Minimum visual-card width — the responsive `auto-fill` grid packs as many columns as
 * fit at this width. Mirrors the virtualised list's constant so a card is the same size
 * whether the grid is flat or grouped.
 */
const VISUAL_CARD_MIN_WIDTH = 280;

interface SharedSectionProps {
  readonly density: LayoutDensity;
  /** Free-text search applied within each section (empty = no text filter). */
  readonly search: string;
  readonly includeInactive: boolean;
  readonly locations: readonly LocationWithCount[];
  readonly locationName: (id: string) => string;
  readonly locationColorClass?: (id: string) => string | undefined;
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
 * This is the grouped counterpart to the flat, virtualised {@link ItemList}. It renders
 * plain DOM rather than virtualising, which suits a browse-by-area workflow; a single
 * location with a very large number of items pages in incrementally via "Show more".
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
      {visibleTree.map((node) => (
        <LocationSection
          key={node.id}
          node={node}
          depth={1}
          isExpanded={isExpanded}
          onToggle={toggle}
          scrollRef={scrollRef}
          {...shared}
        />
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
        <LocationKindIcon
          kind={node.kind}
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
          // opens (fade-through-up); the reduced-motion catch-all neutralises it.
          className="animate-swap-in"
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
  locations,
  locationName,
  locationColorClass,
  selection,
  selectedIds,
  cardFieldsConfig,
}: SharedSectionProps & {
  readonly locationId: string;
  /** A leaf (childless) empty section shows a muted note; a parent just shows its children. */
  readonly isLeaf: boolean;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const filters = useMemo(
    () => ({ locationId, includeInactive, ...(search ? { search } : {}) }),
    [locationId, includeInactive, search],
  );
  const query = useLocationSectionItems(filters);
  const items = useMemo<readonly Item[]>(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);

  // Custom-field values for just this section's loaded items (backlog E1). Skipped entirely
  // unless a custom field is actually shown, so a section costs no extra query in the default
  // configuration. The context bundles the shared config with these per-section values.
  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const fieldValues = useItemFieldValues(itemIds, cardFieldsConfig.hasCustomFields);
  const cardFields: CardFieldsListContext = { ...cardFieldsConfig, values: fieldValues.data };

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

  return (
    <div className="pb-2 pl-6">
      <div
        className={density === 'data' ? 'flex flex-col gap-1.5' : 'grid gap-4'}
        style={
          density === 'data'
            ? undefined
            : { gridTemplateColumns: `repeat(auto-fill, minmax(${VISUAL_CARD_MIN_WIDTH}px, 1fr))` }
        }
      >
        {items.map((item) =>
          density === 'data' ? (
            <ItemRow
              key={item.id}
              item={item}
              locations={locations}
              locationName={locationName(item.locationId)}
              locationColorClass={locationColorClass?.(item.locationId)}
              selection={selection}
              selected={selectedIds?.has(item.id) ?? false}
              {...cardFieldProps(cardFields, item)}
            />
          ) : (
            <ItemCard
              key={item.id}
              item={item}
              locations={locations}
              locationName={locationName(item.locationId)}
              locationColorClass={locationColorClass?.(item.locationId)}
              selection={selection}
              selected={selectedIds?.has(item.id) ?? false}
              {...cardFieldProps(cardFields, item)}
            />
          ),
        )}
      </div>
      {hasNextPage ? (
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
      ) : null}
    </div>
  );
}
