import { useEffect, useState } from 'react';
import { Button, InfoHint, Input } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useUpdateItem } from '../mutations';

/**
 * Per-item reorder-point editor (spec §4 low-stock alerts; Phase 59). Lets a single
 * DISCRETE / CONSUMABLE_GAUGE item carry its **own** low-stock trigger, overriding the
 * global default set in Settings. Left blank, the item simply uses the global default —
 * so an item with no override behaves exactly as it did before (never a regression).
 *
 * Which control is shown follows the item's tracking mode: a DISCRETE item edits a
 * quantity floor (plus an optional suggested top-up); a CONSUMABLE_GAUGE item edits a
 * percentage-remaining floor. SERIALISED single assets aren't bulk stock, so they show
 * nothing. Edits are saved wholesale via {@link useUpdateItem}; an empty field clears the
 * override back to the global default.
 */
export function ReorderPointEditor({ item }: { item: Item }) {
  if (item.trackingMode === 'SERIALISED') {
    return (
      <p className="text-xs text-muted-foreground">
        Reorder points apply to bulk stock — serialised single assets don’t track a low-stock level.
      </p>
    );
  }
  if (item.trackingMode === 'UNTRACKED') {
    return (
      <p className="text-xs text-muted-foreground">
        Reorder points apply to bulk stock — untracked items carry no quantity to run low.
      </p>
    );
  }
  return item.trackingMode === 'CONSUMABLE_GAUGE' ? (
    <GaugeReorderEditor item={item} />
  ) : (
    <DiscreteReorderEditor item={item} />
  );
}

/** Coerce a numeric input string to a value: blank → null (use default), else a number. */
function toValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function DiscreteReorderEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const globalDefault = usePreferencesStore((s) => s.lowStockQtyThreshold);

  const [point, setPoint] = useState(item.reorderPoint?.toString() ?? '');
  const [topUp, setTopUp] = useState(item.reorderQty?.toString() ?? '');

  // Re-sync the draft when the persisted values change (open, after a save, or sync).
  useEffect(() => {
    setPoint(item.reorderPoint?.toString() ?? '');
    setTopUp(item.reorderQty?.toString() ?? '');
  }, [item.reorderPoint, item.reorderQty]);

  const nextPoint = toValue(point);
  const nextTopUp = toValue(topUp);
  const dirty =
    (nextPoint ?? null) !== (item.reorderPoint ?? null) || (nextTopUp ?? null) !== (item.reorderQty ?? null);

  const save = () =>
    update.mutate({ id: item.id, input: { reorderPoint: nextPoint, reorderQty: nextTopUp } });

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Flag this item as low stock at or below its own quantity, rather than the global default.
        <InfoHint
          content={
            'The on-hand quantity at or below which this item is flagged on the **Low Stock** ' +
            'dashboard widget.\n\n' +
            `Leave it blank to use the global default (currently **${globalDefault}** ` +
            'units), set in **Settings → Inventory**. A common screw and a rare connector ' +
            'can each carry their own minimum.\n\n' +
            'The optional **reorder quantity** is a suggested top-up — how many to buy when ' +
            're-ordering. Left blank, the shortfall back up to the reorder point is used.'
          }
        />
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-muted-foreground">
          <span className="mb-field-gap-compact block">Reorder point</span>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={point}
            onChange={(e) => setPoint(e.target.value)}
            placeholder={`Default (${globalDefault})`}
            aria-label="Reorder point"
            data-testid="reorder-point-input"
          />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">
          <span className="mb-field-gap-compact block">Reorder quantity (optional)</span>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={topUp}
            onChange={(e) => setTopUp(e.target.value)}
            placeholder="Suggested top-up"
            aria-label="Reorder quantity"
            data-testid="reorder-qty-input"
          />
        </label>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || update.isPending}
          data-testid="reorder-point-save"
        >
          {dirty ? 'Save reorder point' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

function GaugeReorderEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const globalDefault = usePreferencesStore((s) => s.lowStockGaugePercent);

  const [percent, setPercent] = useState(item.reorderGaugePercent?.toString() ?? '');

  useEffect(() => {
    setPercent(item.reorderGaugePercent?.toString() ?? '');
  }, [item.reorderGaugePercent]);

  const nextPercent = toValue(percent);
  const dirty = (nextPercent ?? null) !== (item.reorderGaugePercent ?? null);

  const save = () => update.mutate({ id: item.id, input: { reorderGaugePercent: nextPercent } });

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Flag this consumable as low when its remaining percentage drops to its own level.
        <InfoHint
          content={
            'The percentage remaining at or below which this consumable is flagged on the ' +
            '**Low Stock** dashboard widget.\n\n' +
            `Leave it blank to use the global default (currently **${globalDefault}%**), set ` +
            'in **Settings → Inventory**.'
          }
        />
      </p>

      <label className="block max-w-[14rem] text-xs font-medium text-muted-foreground">
        <span className="mb-field-gap-compact block">Reorder at (% remaining)</span>
        <Input
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          placeholder={`Default (${globalDefault}%)`}
          aria-label="Reorder gauge percentage"
          data-testid="reorder-gauge-input"
        />
      </label>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || update.isPending}
          data-testid="reorder-point-save"
        >
          {dirty ? 'Save reorder point' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
