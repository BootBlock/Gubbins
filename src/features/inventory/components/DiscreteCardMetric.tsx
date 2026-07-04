import { cn } from '@/lib/utils';
import { Money } from '@/components/foundry';
import { LowStockIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { discreteStockLevel, shortfall, type StockLevel } from '../reorder-policy';

/**
 * The Visual card's hero slot for a plain DISCRETE item (spec §3). The card's ± stepper
 * already shows the on-hand quantity, so this shows a *different*, genuinely useful signal
 * chosen in Settings ({@link usePreferencesStore.visualCardMetric}):
 *
 * - `stockHealth` (default) — a colour-coded reorder status (In stock / Low stock / Out of
 *   stock) derived from the item's effective reorder point, with a "reorder N" hint when low.
 * - `value` — the item's total stock value (`unitCost × quantity`) via the Foundry Money
 *   control, or a muted "Unpriced" when it has no unit cost.
 *
 * Reads its inputs from the Tier-2 preferences store; the reorder-policy maths is the pure,
 * shared {@link discreteStockLevel}/{@link shortfall} seam (never recomputed here).
 */
export function DiscreteCardMetric({ item }: { item: Item }) {
  const metric = usePreferencesStore((s) => s.visualCardMetric);
  return metric === 'value' ? <ValueMetric item={item} /> : <StockHealthMetric item={item} />;
}

const STOCK_STYLE: Record<StockLevel, { text: string; label: string; Icon: typeof SuccessIcon }> = {
  healthy: { text: 'text-glyph-success', label: 'In stock', Icon: SuccessIcon },
  low: { text: 'text-warning', label: 'Low stock', Icon: LowStockIcon },
  out: { text: 'text-glyph-danger', label: 'Out of stock', Icon: WarningIcon },
};

function StockHealthMetric({ item }: { item: Item }) {
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const defaults = { qtyThreshold, gaugePercent };
  const level = discreteStockLevel(item, defaults);
  const { text, label, Icon } = STOCK_STYLE[level];
  const reorder = shortfall(item, defaults);

  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn('inline-flex items-center gap-1.5 text-lg font-semibold [&_svg]:size-4', text)}>
        <Icon aria-hidden />
        {label}
      </span>
      {level === 'low' && reorder > 0 ? (
        <span className="text-xs tabular-nums text-muted-foreground">reorder {reorder}</span>
      ) : null}
    </div>
  );
}

function ValueMetric({ item }: { item: Item }) {
  const priced = item.unitCost != null && Number.isFinite(item.unitCost);
  return (
    <div className="flex items-center justify-between gap-2">
      {priced ? (
        <Money value={item.unitCost! * item.quantity} className="text-2xl font-bold" />
      ) : (
        <span className="text-2xl font-bold text-muted-foreground">—</span>
      )}
      <span className="text-xs text-muted-foreground">{priced ? 'total value' : 'unpriced'}</span>
    </div>
  );
}
