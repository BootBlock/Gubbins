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
        Set a quantity to watch this item for low stock — alerts stay off until you do.
        <InfoHint
          content={
            'The on-hand quantity at or below which this item is flagged on the **Low Stock** ' +
            'dashboard widget. Low-stock alerts are **opt-in** — set a value here to switch ' +
            'them on for this item; **0** turns them off again.\n\n' +
            (globalDefault > 0
              ? `Leave it blank to use the global default (currently **${globalDefault}** units), ` +
                'set in **Settings → Inventory** — or set 0 here to opt this one item out.'
              : 'Leave it blank and the item stays off — the global default in ' +
                '**Settings → Inventory** is currently off, so nothing is watched until you set a value.') +
            '\n\nA common screw and a rare connector can each carry their own minimum.\n\n' +
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
            placeholder={globalDefault > 0 ? `Default (${globalDefault})` : 'Off — set to alert'}
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
        Set a percentage to watch this consumable for low stock — alerts stay off until you do.
        <InfoHint
          content={
            'The percentage remaining at or below which this consumable is flagged on the ' +
            '**Low Stock** dashboard widget. Low-stock alerts are **opt-in** — set a value here ' +
            'to switch them on for this item; **0** turns them off again.\n\n' +
            (globalDefault > 0
              ? `Leave it blank to use the global default (currently **${globalDefault}%**), set ` +
                'in **Settings → Inventory** — or set 0 here to opt this one item out.'
              : 'Leave it blank and the item stays off — the global default in ' +
                '**Settings → Inventory** is currently off.')
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
          placeholder={globalDefault > 0 ? `Default (${globalDefault}%)` : 'Off — set to alert'}
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
