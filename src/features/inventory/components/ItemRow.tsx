import { cn } from '@/lib/utils';
import type { Item, LocationWithCount } from '@/db/repositories';
import { formatMeasure, formatQuantity } from './inventory-ui';
import { GaugeRing } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';
import { TrackingBadge } from './TrackingBadge';
import { ItemActions } from './ItemActions';

/**
 * Data-Heavy item presentation (spec §3): a dense, tabular row optimised for
 * scanning many records at once.
 */
export function ItemRow({
  item,
  locations,
  locationName,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 transition-colors hover:bg-card/80',
        !item.isActive && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="truncate text-xs text-muted-foreground">{locationName}</p>
      </div>

      <TrackingBadge mode={item.trackingMode} className="hidden sm:inline-flex" />

      <div className="flex w-40 items-center justify-end gap-2">
        {item.gauge ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatMeasure(item.gauge.currentNetValue, item.gauge.unitOfMeasure)}
            </span>
            <GaugeRing gauge={item.gauge} size={32} />
          </>
        ) : item.trackingMode === 'SERIALISED' ? (
          <span className="text-xs text-muted-foreground">1 unit</span>
        ) : item.isActive ? (
          <QuantityStepper id={item.id} quantity={item.quantity} />
        ) : (
          <span className="text-sm font-semibold tabular-nums">{formatQuantity(item.quantity)}</span>
        )}
      </div>

      <ItemActions item={item} locations={locations} compact />
    </div>
  );
}
