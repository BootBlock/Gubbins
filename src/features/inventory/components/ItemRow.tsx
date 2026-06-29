import { cn } from '@/lib/utils';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { GaugeRing } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';
import { TrackingBadge } from './TrackingBadge';
import { ItemActions } from './ItemActions';
import type { ItemSelection } from './inventory-ui';

/**
 * Data-Heavy item presentation (spec §3): a dense, tabular row optimised for
 * scanning many records at once. When `selection` is provided (the §6 batch
 * QR-label flow, Phase 49) a selection checkbox is shown.
 */
export function ItemRow({
  item,
  locations,
  locationName,
  locationColorClass,
  selection,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  /** Tailwind text-colour class for the location's swatch tint, if any. */
  locationColorClass?: string;
  selection?: ItemSelection;
}) {
  const fmt = useFormatters();
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 transition-colors hover:bg-card/80',
        !item.isActive && 'opacity-60',
        selection?.selectedIds.has(item.id) && 'border-primary/60 bg-primary/5',
      )}
    >
      {selection ? (
        <input
          type="checkbox"
          checked={selection.selectedIds.has(item.id)}
          onChange={() => selection.onToggle(item)}
          aria-label={`Select ${item.name}`}
          data-testid="item-select"
          className="size-4 shrink-0 accent-primary"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className={cn('truncate text-xs', locationColorClass ?? 'text-muted-foreground')}>
          {locationName}
        </p>
      </div>

      <TrackingBadge mode={item.trackingMode} className="hidden sm:inline-flex" />

      <div className="flex w-40 items-center justify-end gap-2">
        {item.gauge ? (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {fmt.measure(item.gauge.currentNetValue, item.gauge.unitOfMeasure)}
            </span>
            <GaugeRing gauge={item.gauge} size={32} />
          </>
        ) : item.trackingMode === 'SERIALISED' ? (
          <span className="text-xs text-muted-foreground">1 unit</span>
        ) : item.isActive ? (
          <QuantityStepper id={item.id} quantity={item.quantity} />
        ) : (
          <span className="text-sm font-semibold tabular-nums">{fmt.quantity(item.quantity)}</span>
        )}
      </div>

      <ItemActions item={item} locations={locations} compact />
    </div>
  );
}
