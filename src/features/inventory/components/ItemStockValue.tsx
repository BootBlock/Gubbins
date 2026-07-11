import type { Item } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { UNLIMITED_GLYPH, isUnlimited } from '../unlimited';
import { GaugeRing } from './GaugeBar';
import { QuantityStepper } from './QuantityStepper';

/**
 * The stock figure for one item, branched by tracking mode — the shared display behind both the
 * dense Data {@link ItemRow} and the spreadsheet {@link ItemTableRow} so the two never diverge:
 *
 * - **Unlimited** — the ∞ glyph (an unlimited item has no finite count).
 * - **Gauge** — the remaining measure plus a {@link GaugeRing}.
 * - **Serialised** — always exactly "1 unit".
 * - **Untracked** — "Not counted" (no quantity is kept).
 * - **Active discrete** — the ± {@link QuantityStepper} for in-place adjustment.
 * - **Removed** — a static count (a soft-deleted item isn't adjustable).
 *
 * The caller supplies the surrounding layout (width, alignment); this renders only the value(s).
 */
export function ItemStockValue({ item, gaugeSize = 32 }: { item: Item; gaugeSize?: number }) {
  const fmt = useFormatters();
  if (isUnlimited(item)) {
    return (
      <span
        className="text-lg font-semibold text-glyph-scan"
        aria-label="Unlimited supply"
        title="Unlimited supply"
      >
        {UNLIMITED_GLYPH}
      </span>
    );
  }
  if (item.gauge) {
    return (
      <>
        <span className="text-xs tabular-nums text-muted-foreground">
          {fmt.measure(item.gauge.currentNetValue, item.gauge.unitOfMeasure)}
        </span>
        <GaugeRing gauge={item.gauge} size={gaugeSize} />
      </>
    );
  }
  if (item.trackingMode === 'SERIALISED') {
    return <span className="text-xs text-muted-foreground">1 unit</span>;
  }
  if (item.trackingMode === 'UNTRACKED') {
    return <span className="text-xs text-muted-foreground">Not counted</span>;
  }
  if (item.isActive) {
    return <QuantityStepper id={item.id} quantity={item.quantity} />;
  }
  return <span className="text-sm font-semibold tabular-nums">{fmt.quantity(item.quantity)}</span>;
}
