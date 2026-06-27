import { cn } from '@/lib/utils';
import { Surface } from '@/components/foundry';
import { FolderIcon } from '@/components/icons';
import type { Item, LocationWithCount } from '@/db/repositories';
import { formatQuantity } from './inventory-ui';
import { GaugeBar } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';
import { TrackingBadge } from './TrackingBadge';
import { ItemActions } from './ItemActions';

/**
 * Visual-Heavy item presentation (spec §3): a large, striking card with bold
 * typography, the gauge visualisation front-and-centre, and tactile hover lift.
 */
export function ItemCard({
  item,
  locations,
  locationName,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
}) {
  return (
    <Surface
      className={cn(
        'flex flex-col gap-4 p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-primary/10',
        !item.isActive && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight">{item.name}</h3>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
            <FolderIcon />
            {locationName}
          </p>
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
            <span className="text-2xl font-bold tabular-nums">{formatQuantity(item.quantity)}</span>
            <span className="text-xs text-muted-foreground">in stock</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border/60 pt-3">
        {item.trackingMode === 'DISCRETE' && item.isActive ? (
          <QuantityStepper id={item.id} quantity={item.quantity} />
        ) : (
          <span />
        )}
        <ItemActions item={item} locations={locations} />
      </div>
    </Surface>
  );
}
