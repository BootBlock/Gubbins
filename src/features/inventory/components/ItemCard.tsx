import { cn } from '@/lib/utils';
import { Surface } from '@/components/foundry';
import { FolderIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { GaugeBar } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';
import { Thumbnail } from './Thumbnail';
import { TrackingBadge } from './TrackingBadge';
import { ItemActions } from './ItemActions';
import type { ItemSelection } from './inventory-ui';

/**
 * Visual-Heavy item presentation (spec §3): a large, striking card with bold
 * typography, the gauge visualisation front-and-centre, and tactile hover lift.
 * When `selection` is provided (the §6 batch QR-label flow, Phase 49) a selection
 * checkbox is shown.
 */
export function ItemCard({
  item,
  locations,
  locationName,
  selection,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  selection?: ItemSelection;
}) {
  const fmt = useFormatters();
  return (
    <Surface
      className={cn(
        'flex flex-col gap-4 p-5 transition-all duration-200 ease-emphasized hover:-translate-y-1 hover:shadow-primary/10',
        !item.isActive && 'opacity-60',
        selection?.selectedIds.has(item.id) && 'ring-2 ring-primary/60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {selection ? (
            <input
              type="checkbox"
              checked={selection.selectedIds.has(item.id)}
              onChange={() => selection.onToggle(item)}
              aria-label={`Select ${item.name}`}
              data-testid="item-select"
              className="mt-1 size-4 shrink-0 accent-primary"
            />
          ) : null}
          {item.thumbnailBlob ? (
            <Thumbnail
              bytes={item.thumbnailBlob}
              alt={item.name}
              className="size-11 shrink-0 rounded-lg border border-border/60"
            />
          ) : null}
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold tracking-tight">
              {item.name}
              {item.serialNo !== null ? (
                <span className="ml-1 text-muted-foreground">#{item.serialNo}</span>
              ) : null}
            </h3>
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
              <FolderIcon />
              {locationName}
            </p>
          </div>
        </div>
        <TrackingBadge mode={item.trackingMode} />
      </div>

      <div className="flex-1">
        {item.gauge ? (
          <GaugeBar gauge={item.gauge} />
        ) : item.trackingMode === 'SERIALISED' ? (
          <p className="text-sm text-muted-foreground">Single serialised unit</p>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold tabular-nums">{fmt.quantity(item.quantity)}</span>
            <span className="text-xs text-muted-foreground">in stock</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        {item.trackingMode === 'DISCRETE' && item.isActive ? (
          <QuantityStepper id={item.id} quantity={item.quantity} />
        ) : (
          <span />
        )}
        <ItemActions item={item} locations={locations} compact />
      </div>
    </Surface>
  );
}
