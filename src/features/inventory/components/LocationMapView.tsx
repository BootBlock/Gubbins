import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChevronRightIcon, PackageIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import type { LocationTreeNode } from '@/db/repositories';
import { buildLocationMap, type LocationMapTile } from '../location-map';
import { locationFullness } from '../location-fullness';
import { squarifyTreemap } from '../treemap-layout';
import { tileClasses } from './viz-tiles';
import { useElementSize } from './useElementSize';
import { LocationFullnessBar } from './LocationFullnessBar';

/** Gap (px) inset around each tile so adjacent tiles read as separate. */
const TILE_GAP = 4;

/**
 * The **location map** inventory view: a spatial, drill-down treemap of the location hierarchy.
 * One level shows at a time — the direct children of the current map root — each tile sized by how
 * much stock sits in that place and everything beneath it, and tinted by the location's own colour
 * (with a fullness bar where a capacity is set). It answers "where is my stuff / what's full?" at a
 * glance, then lets you drill: a tile with sub-locations re-roots the map into it (a breadcrumb
 * walks back out); a leaf opens that location's items in the card view.
 *
 * All the counting/navigation maths lives in the pure `location-map` seam; this component measures
 * the container, lays the tiles out via `treemap-layout`, and wires the clicks.
 */
export function LocationMapView({
  tree,
  onSelectLocation,
  onBrowseLocation,
}: {
  /** The full nested location hierarchy. */
  tree: readonly LocationTreeNode[];
  /** Select a location in the sidebar (called when re-rooting into a parent). */
  onSelectLocation: (id: string) => void;
  /** Open a location's items — selects it and switches to the card view (for a leaf tile). */
  onBrowseLocation: (id: string) => void;
}) {
  const fmt = useFormatters();
  const [rootId, setRootId] = useState<string | null>(null);
  const [sizeRef, size] = useElementSize();

  const { tiles: mapTiles, ancestry } = useMemo(() => buildLocationMap(tree, rootId), [tree, rootId]);

  const laidOut = useMemo(() => {
    if (mapTiles.length === 0 || size.width <= 0 || size.height <= 0) return [];
    return squarifyTreemap(mapTiles, size.width, size.height);
  }, [mapTiles, size.width, size.height]);

  const openTile = (tile: LocationMapTile) => {
    if (tile.childCount > 0) {
      // Drill spatially into a place that nests others, and reflect the move in the sidebar.
      setRootId(tile.id);
      onSelectLocation(tile.id);
    } else {
      // A leaf: open its items in the list.
      onBrowseLocation(tile.id);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="Location map">
      {/* Breadcrumb: the trail from "All locations" down to the current map root; each step re-roots. */}
      <nav aria-label="Map location" className="flex flex-wrap items-center gap-1 px-1 text-sm">
        <Crumb label="All locations" onClick={() => setRootId(null)} current={rootId === null} />
        {ancestry.map((node) => (
          <span key={node.id} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <Crumb label={node.name} onClick={() => setRootId(node.id)} current={node.id === rootId} />
          </span>
        ))}
        <span className="ml-2 text-xs text-muted-foreground">
          Tiles are sized by how much stock each place holds — click to drill in.
        </span>
      </nav>

      {laidOut.length === 0 && mapTiles.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground [&_svg]:size-7">
            <PackageIcon aria-hidden />
          </span>
          <div className="max-w-md">
            <p className="font-medium">Nothing to map here</p>
            <p className="text-sm text-muted-foreground">
              This place has no sub-locations. Head back out, or browse its items directly.
            </p>
          </div>
        </div>
      ) : (
        <div ref={sizeRef} className="relative min-h-0 flex-1" data-testid="location-map">
          {laidOut.map(({ datum, x, y, width, height }) => {
            const fullness = locationFullness(datum.directCount, datum.capacity);
            const { wash, text } = tileClasses(datum.id, datum.color);
            const showBody = width >= 80 && height >= 56;
            const showBar = fullness && width >= 96 && height >= 78;
            const countLabel = `${fmt.quantity(datum.subtreeCount)} ${datum.subtreeCount === 1 ? 'item' : 'items'}`;
            const ariaName =
              `${datum.name}, ${countLabel}` +
              (datum.childCount > 0 ? `, ${fmt.quantity(datum.childCount)} sub-locations` : '') +
              (fullness ? `, ${fullness.percent}% full` : '');
            return (
              <button
                key={datum.id}
                type="button"
                onClick={() => openTile(datum)}
                aria-label={ariaName}
                className={cn(
                  'absolute flex flex-col overflow-hidden rounded-lg border border-border/60 p-2.5 text-left',
                  'transition-[left,top,width,height,box-shadow] duration-500 ease-emphasized',
                  'hover:border-border focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  'hover:shadow-md',
                  wash,
                )}
                style={{
                  left: x + TILE_GAP / 2,
                  top: y + TILE_GAP / 2,
                  width: Math.max(0, width - TILE_GAP),
                  height: Math.max(0, height - TILE_GAP),
                }}
              >
                <span className="flex min-w-0 items-center gap-1">
                  <span className={cn('min-w-0 truncate text-sm font-semibold', text)}>{datum.name}</span>
                  {datum.childCount > 0 ? (
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : null}
                </span>
                {showBody ? (
                  <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                    {countLabel}
                  </span>
                ) : null}
                {showBar ? (
                  <div className="mt-auto w-full pt-2">
                    <LocationFullnessBar fullness={fullness} />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One breadcrumb step: a button unless it is the current level (then a plain, aria-current label). */
function Crumb({ label, onClick, current }: { label: string; onClick: () => void; current: boolean }) {
  if (current) {
    return (
      <span aria-current="location" className="font-medium">
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {label}
    </button>
  );
}
