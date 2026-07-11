import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Money, Spinner } from '@/components/foundry';
import { TreemapViewIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import type { GroupingMode } from '@/state/stores/useLayoutStore';
import type { ValueGroup } from '@/features/reports/reports';
import { useInventoryValue } from '@/features/reports/queries';
import { squarifyTreemap } from '../treemap-layout';
import { useElementSize } from './useElementSize';
import { tileClasses } from './viz-tiles';

/** Gap (px) inset around each tile so adjacent fills read as separate (dataviz surface gap). */
const TILE_GAP = 3;

/** A value group carrying the treemap weight (its total stock value). */
interface WeightedGroup extends ValueGroup {
  readonly weight: number;
}

/**
 * The **value treemap** inventory view: tiles whose area is proportional to the total stock value
 * they hold, so the eye lands on where the money sits. Grouped by category by default, or by
 * location when the grouping axis is "By location" — reusing the existing Group-by control rather
 * than adding a second one.
 *
 * Value = on-hand count × effective unit cost, reusing the Reports valuation exactly (the shared
 * `useInventoryValue` aggregation), so the treemap agrees with the valuation report to the penny.
 * Colour comes from the app's semantic location palette (see {@link tileClasses}); area carries the
 * magnitude and every tile is directly labelled, so identity never rests on colour alone. The
 * squarified geometry lives in the pure `treemap-layout` seam; this component only measures the
 * container and paints the tiles, plus a screen-reader list that stands in as the table view.
 */
export function ValueTreemapView({ grouping }: { grouping: GroupingMode }) {
  const value = useInventoryValue();
  const fmt = useFormatters();
  const [sizeRef, size] = useElementSize();

  const byLocation = grouping === 'location';
  const groups = byLocation ? value.data?.byLocation : value.data?.byCategory;
  const dimensionLabel = byLocation ? 'location' : 'category';

  const total = value.data?.totalValue ?? 0;

  // Lay the value groups out as a squarified treemap in the measured container. Recomputed only
  // when the data or the container size changes.
  const tiles = useMemo(() => {
    if (!groups || size.width <= 0 || size.height <= 0) return [];
    const weighted: WeightedGroup[] = groups
      .filter((g) => g.value > 0)
      .map((g) => ({ ...g, weight: g.value }));
    return squarifyTreemap(weighted, size.width, size.height);
  }, [groups, size.width, size.height]);

  if (value.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const hasValue = total > 0 && (groups?.some((g) => g.value > 0) ?? false);
  if (!hasValue) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground [&_svg]:size-7">
          <TreemapViewIcon aria-hidden />
        </span>
        <div className="max-w-md">
          <p className="font-medium">No value to map yet</p>
          <p className="text-sm text-muted-foreground">
            Give your items a unit cost (or a preferred supplier price) and this view will size each{' '}
            {dimensionLabel} by the value of the stock it holds.
          </p>
        </div>
      </div>
    );
  }

  const orderedGroups = (groups ?? []).filter((g) => g.value > 0);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3"
      aria-label={`Inventory value by ${dimensionLabel}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <p className="text-sm text-muted-foreground">
          Value by {dimensionLabel}
          {byLocation ? '' : ' — switch “Group by” to Location to re-slice by place'}
        </p>
        <p className="text-sm text-muted-foreground">
          Total <Money value={total} className="font-semibold text-foreground" animate />
          {value.data && value.data.unpricedItemCount > 0 ? (
            <span className="ml-2 text-xs">
              ({fmt.quantity(value.data.unpricedItemCount)} unpriced, not shown)
            </span>
          ) : null}
        </p>
      </div>

      {/* The visual treemap. Marked aria-hidden because the absolutely-positioned, truncated tiles
          read poorly in sequence; the ordered list below is the screen-reader / table equivalent. */}
      <div ref={sizeRef} className="relative min-h-0 flex-1" aria-hidden="true">
        {tiles.map(({ datum, x, y, width, height }) => {
          const share = total > 0 ? datum.value / total : 0;
          const { wash, text } = tileClasses(datum.id, null);
          const showName = width >= 60 && height >= 30;
          const showValue = width >= 76 && height >= 50;
          return (
            <div
              key={datum.id ?? '__ungrouped'}
              className={cn(
                'absolute overflow-hidden rounded-md border border-border/60 p-2',
                'transition-[left,top,width,height] duration-500 ease-emphasized',
                wash,
              )}
              style={{
                left: x + TILE_GAP / 2,
                top: y + TILE_GAP / 2,
                width: Math.max(0, width - TILE_GAP),
                height: Math.max(0, height - TILE_GAP),
              }}
              title={`${datum.name} — ${fmt.currency(datum.value)} (${fmt.percent(share)})`}
            >
              {showName ? (
                <span className={cn('block truncate text-xs font-semibold', text)}>{datum.name}</span>
              ) : null}
              {showValue ? (
                <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                  <Money value={datum.value} /> · {fmt.percent(share)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Table-equivalent for assistive tech (dataviz: a table view always exists). Visually hidden
          because the tiles carry the same information on screen. */}
      <ul className="sr-only">
        {orderedGroups.map((g) => (
          <li key={g.id ?? '__ungrouped'}>
            {g.name}: {fmt.currency(g.value)} ({fmt.percent(total > 0 ? g.value / total : 0)} of total),{' '}
            {fmt.quantity(g.quantity)} items
          </li>
        ))}
      </ul>
    </section>
  );
}
