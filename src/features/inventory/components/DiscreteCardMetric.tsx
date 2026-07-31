import { assertExhaustive } from '@/lib/exhaustive';
import { cn } from '@/lib/utils';
import { Money } from '@/components/foundry';
import { LowStockIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { discreteStockLevel, shortfall, type StockLevel } from '../reorder-policy';
import { resolveVisualCardMetric } from '../visual-card-metric';
import { CONDITION_COLOR_CLASS, CONDITION_LABELS } from './inventory-ui';
import { itemTotalValue } from '../item-total-value';

/**
 * The Visual card's hero slot for a plain DISCRETE item (spec §3). The card's ± stepper
 * already shows the on-hand quantity, so this shows a *different*, genuinely useful signal
 * chosen in Settings ({@link usePreferencesStore.visualCardMetric}):
 *
 * - `stockHealth` (default) — a colour-coded reorder status (In stock / Low stock / Out of
 *   stock) derived from the item's effective reorder point, with a "reorder N" hint when low.
 * - `value` — the item's total stock value (`unitCost × quantity`) via the Foundry Money
 *   control, or a muted "Unpriced" when it has no unit cost.
 * - `lastUpdated` — how long ago the item last changed, as a relative time (e.g. "3 days
 *   ago") via the shared `relativeTime` formatter.
 * - `condition` — the item's tracked condition, tinted with its `text-cond-*` token, or a
 *   muted "Untracked" when it has none.
 * - `manufacturer` — the item's manufacturer/brand, or a muted em-dash when unset.
 *
 * When the chosen metric has nothing to show for an item, the user's fallback metric shows
 * instead (issue #107) — the pure {@link resolveVisualCardMetric} seam decides which id to
 * render. Reads its inputs from the Tier-2 preferences store; the reorder-policy maths is the
 * pure, shared {@link discreteStockLevel}/{@link shortfall} seam (never recomputed here).
 */
export function DiscreteCardMetric({ item }: { item: Item }) {
  const primary = usePreferencesStore((s) => s.visualCardMetric);
  const fallback = usePreferencesStore((s) => s.visualCardMetricFallback);
  const metric = resolveVisualCardMetric(item, primary, fallback);
  switch (metric) {
    case 'stockHealth':
      return <StockHealthMetric item={item} />;
    case 'value':
      return <ValueMetric item={item} />;
    case 'lastUpdated':
      return <LastUpdatedMetric item={item} />;
    case 'condition':
      return <ConditionMetric item={item} />;
    case 'manufacturer':
      return <ManufacturerMetric item={item} />;
    default:
      // Exhaustiveness guard (#355): a new VisualCardMetric must extend this switch or this
      // stops compiling. Without it `metricHasContent` would demand attention for the new
      // metric while the hero slot quietly drew stock health instead. Stock health stays the
      // runtime fallback — it is the one metric every item can always show.
      assertExhaustive(metric);
      return <StockHealthMetric item={item} />;
  }
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
  // The same {@link itemTotalValue} rule that decides whether this metric is *available*
  // (`metricHasContent`), so the gate and the figure can never state different rules.
  const total = itemTotalValue(item);
  return (
    <div className="flex items-center justify-between gap-2">
      {total === null ? (
        <span className="text-2xl font-bold text-muted-foreground">—</span>
      ) : (
        <Money value={total} className="text-2xl font-bold" />
      )}
      <span className="text-xs text-muted-foreground">{total === null ? 'unpriced' : 'total value'}</span>
    </div>
  );
}

function LastUpdatedMetric({ item }: { item: Item }) {
  const fmt = useFormatters();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-lg font-semibold text-foreground">{fmt.relativeTime(item.updatedAt)}</span>
      <span className="text-xs text-muted-foreground">last updated</span>
    </div>
  );
}

function ConditionMetric({ item }: { item: Item }) {
  const tracked = item.condition != null;
  return (
    <div className="flex items-center justify-between gap-2">
      {tracked ? (
        <span className={cn('text-lg font-semibold', CONDITION_COLOR_CLASS[item.condition!])}>
          {CONDITION_LABELS[item.condition!]}
        </span>
      ) : (
        <span className="text-lg font-semibold text-muted-foreground">Untracked</span>
      )}
      <span className="text-xs text-muted-foreground">condition</span>
    </div>
  );
}

function ManufacturerMetric({ item }: { item: Item }) {
  const named = item.manufacturer != null && item.manufacturer.trim() !== '';
  return (
    <div className="flex items-center justify-between gap-2">
      {named ? (
        <span className="min-w-0 truncate text-lg font-semibold text-foreground">{item.manufacturer}</span>
      ) : (
        <span className="text-lg font-semibold text-muted-foreground">—</span>
      )}
      <span className="shrink-0 text-xs text-muted-foreground">manufacturer</span>
    </div>
  );
}
