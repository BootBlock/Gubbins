import { useEffect, useState, type ReactNode } from 'react';
import { Button, Checkbox, InfoHint, Input } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { LOW_STOCK_GAUGE_SUGGESTED, LOW_STOCK_QTY_SUGGESTED } from '@/db/repositories/constants';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useUpdateItem } from '../mutations';

/**
 * Per-item low-stock editor (spec §4 low-stock alerts; Phase 59). Lets a single
 * DISCRETE / CONSUMABLE_GAUGE item opt in to low-stock alerts with its **own** trigger.
 *
 * Low-stock alerts are **opt-in**, so this mirrors the Add-item dialog exactly: an explicit
 * "Alert me when this runs low" switch that, when on, reveals the trigger field(s) (a
 * quantity floor + optional top-up for DISCRETE; a percentage floor for CONSUMABLE_GAUGE),
 * seeded with a sensible suggestion. Switching it off clears the per-item override — the
 * item then follows the global default in Settings (off unless the user has raised it).
 * SERIALISED single assets and UNTRACKED items aren't bulk stock, so they show nothing.
 */
export function ReorderPointEditor({ item }: { item: Item }) {
  if (item.trackingMode === 'SERIALISED') {
    return (
      <p className="text-xs text-muted-foreground">
        Low-stock alerts apply to bulk stock — serialised single assets don’t track a low-stock level.
      </p>
    );
  }
  if (item.trackingMode === 'UNTRACKED') {
    return (
      <p className="text-xs text-muted-foreground">
        Low-stock alerts apply to bulk stock — untracked items carry no quantity to run low.
      </p>
    );
  }
  return item.trackingMode === 'CONSUMABLE_GAUGE' ? (
    <GaugeReorderEditor item={item} />
  ) : (
    <DiscreteReorderEditor item={item} />
  );
}

/** Coerce a numeric input string to a value: blank → null, else a finite number. */
function toValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** An item is "watched" only when it carries its own *positive* reorder floor (0 = off). */
function ownFloor(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

/**
 * The shared opt-in switch + revealed trigger fields (identical framing to the dialog).
 * Returns a fragment so the caller controls spacing and can keep the Save button visible
 * *outside* the reveal — the user must be able to save the "off" state to clear an override.
 */
function AlertToggle({
  enabled,
  onToggle,
  hint,
  children,
}: {
  enabled: boolean;
  onToggle: (checked: boolean) => void;
  hint: string;
  children: ReactNode;
}) {
  return (
    <>
      <label className="flex cursor-pointer items-center gap-1.5 text-sm font-medium">
        <Checkbox
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          data-testid="reorder-alert-toggle"
        />
        Alert me when this runs low
        <InfoHint content={hint} />
      </label>
      {enabled ? children : null}
    </>
  );
}

function SaveButton({ dirty, pending, onClick }: { dirty: boolean; pending: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-end">
      <Button size="sm" onClick={onClick} disabled={!dirty || pending} data-testid="reorder-point-save">
        {dirty ? 'Save' : 'Saved'}
      </Button>
    </div>
  );
}

function DiscreteReorderEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const globalDefault = usePreferencesStore((s) => s.lowStockQtyThreshold);

  const currentPoint = ownFloor(item.reorderPoint);
  const [enabled, setEnabled] = useState(currentPoint != null);
  const [point, setPoint] = useState(currentPoint?.toString() ?? '');
  const [topUp, setTopUp] = useState(item.reorderQty?.toString() ?? '');

  // Re-sync the draft when the persisted values change (open, after a save, or sync).
  useEffect(() => {
    const floor = ownFloor(item.reorderPoint);
    setEnabled(floor != null);
    setPoint(floor?.toString() ?? '');
    setTopUp(item.reorderQty?.toString() ?? '');
  }, [item.reorderPoint, item.reorderQty]);

  // Switching on seeds a friendly suggestion so the revealed field is never blank.
  const toggle = (checked: boolean) => {
    setEnabled(checked);
    if (checked && !point.trim()) setPoint(String(LOW_STOCK_QTY_SUGGESTED));
  };

  const targetPoint = enabled ? toValue(point) : null;
  const targetTopUp = enabled ? toValue(topUp) : null;
  const currentTopUp = item.reorderQty ?? null;
  const dirty = targetPoint !== currentPoint || targetTopUp !== currentTopUp;

  const save = () =>
    update.mutate({ id: item.id, input: { reorderPoint: targetPoint, reorderQty: targetTopUp } });

  const hint =
    'The on-hand quantity at or below which this item is flagged on the **Low Stock** ' +
    'dashboard widget.\n\nLow-stock alerts are **opt-in** — turn this on to watch this item. ' +
    'Turn it off and the item follows the global default in **Settings → Inventory**' +
    (globalDefault > 0 ? ` (currently **${globalDefault}** units).` : ', which is currently **off**.') +
    '\n\nThe optional **reorder quantity** is a suggested top-up — how many to buy when ' +
    're-ordering. Left blank, the shortfall back up to the reorder point is used.';

  return (
    <div className="space-y-3">
      <AlertToggle enabled={enabled} onToggle={toggle} hint={hint}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted-foreground">
            <span className="mb-field-gap-compact block">Reorder point</span>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={point}
              onChange={(e) => setPoint(e.target.value)}
              placeholder={`e.g. ${LOW_STOCK_QTY_SUGGESTED}`}
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
      </AlertToggle>
      <SaveButton dirty={dirty} pending={update.isPending} onClick={save} />
    </div>
  );
}

function GaugeReorderEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const globalDefault = usePreferencesStore((s) => s.lowStockGaugePercent);

  const currentPercent = ownFloor(item.reorderGaugePercent);
  const [enabled, setEnabled] = useState(currentPercent != null);
  const [percent, setPercent] = useState(currentPercent?.toString() ?? '');

  useEffect(() => {
    const floor = ownFloor(item.reorderGaugePercent);
    setEnabled(floor != null);
    setPercent(floor?.toString() ?? '');
  }, [item.reorderGaugePercent]);

  const toggle = (checked: boolean) => {
    setEnabled(checked);
    if (checked && !percent.trim()) setPercent(String(LOW_STOCK_GAUGE_SUGGESTED));
  };

  const targetPercent = enabled ? toValue(percent) : null;
  const dirty = targetPercent !== currentPercent;

  const save = () => update.mutate({ id: item.id, input: { reorderGaugePercent: targetPercent } });

  const hint =
    'The percentage remaining at or below which this consumable is flagged on the ' +
    '**Low Stock** dashboard widget.\n\nLow-stock alerts are **opt-in** — turn this on to ' +
    'watch this item. Turn it off and the item follows the global default in ' +
    '**Settings → Inventory**' +
    (globalDefault > 0 ? ` (currently **${globalDefault}%**).` : ', which is currently **off**.');

  return (
    <div className="space-y-3">
      <AlertToggle enabled={enabled} onToggle={toggle} hint={hint}>
        <label className="block max-w-[14rem] text-xs font-medium text-muted-foreground">
          <span className="mb-field-gap-compact block">Reorder at (% remaining)</span>
          <Input
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            placeholder={`e.g. ${LOW_STOCK_GAUGE_SUGGESTED}`}
            aria-label="Reorder gauge percentage"
            data-testid="reorder-gauge-input"
          />
        </label>
      </AlertToggle>
      <SaveButton dirty={dirty} pending={update.isPending} onClick={save} />
    </div>
  );
}
