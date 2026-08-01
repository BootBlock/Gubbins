import { useEffect, useId, useState } from 'react';
import {
  Button,
  InfoHint,
  Input,
  Tooltip,
  INFO_OPEN_DELAY_MS,
  useReportUnsavedChanges,
} from '@/components/foundry';
import { TruckIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { LOW_STOCK_GAUGE_SUGGESTED, LOW_STOCK_QTY_SUGGESTED } from '@/db/repositories/constants';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useOnOrderQty } from '@/features/purchasing/queries';
import { policyFromValue, valueForPolicy, type LowStockPolicy } from '../low-stock-policy';
import { useUpdateItem } from '../mutations';
import { LowStockPolicyPicker } from './LowStockPolicyPicker';

/**
 * Per-item low-stock editor (spec §4 low-stock alerts; Phase 59). Lets a single
 * DISCRETE / CONSUMABLE_GAUGE item choose its low-stock alert policy, mirroring the
 * Add-item dialog exactly (a shared {@link LowStockPolicyPicker}):
 *
 * - **Default** — follow the global blanket in Settings (off unless the user raised it).
 * - **Custom** — the item's own positive trigger (a quantity floor + optional top-up for
 *   DISCRETE, a percentage floor for CONSUMABLE_GAUGE), seeded with a suggestion.
 * - **Never** — a hard exemption; the item is never flagged, even with a global blanket on.
 *
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

/** The "custom" level is only savable when it's a genuine positive floor. */
function customInvalid(policy: LowStockPolicy, customValue: number | null): boolean {
  return policy === 'custom' && !(customValue != null && customValue > 0);
}

/** Copy shown below the picker for the non-custom policies. */
function PolicyNote({ policy, defaultLabel }: { policy: LowStockPolicy; defaultLabel: string }) {
  if (policy === 'never') {
    return (
      <p className="text-xs text-muted-foreground">
        This item is never flagged as low stock, even if a global default is switched on.
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">{defaultLabel}</p>;
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

const DISCRETE_HINT =
  'How this item is watched on the **Low Stock** dashboard widget.\n\n' +
  '- **Default** — follow the global default in **Settings → Inventory** (watched at that ' +
  'level if it’s on, silent if it’s off).\n' +
  '- **Custom** — flag it at or below your own on-hand quantity. The optional **reorder ' +
  'quantity** is a suggested top-up for the shopping list.\n' +
  '- **Never** — a hard exemption: this item is never flagged, even if a global default is set.';

const GAUGE_HINT =
  'How this consumable is watched on the **Low Stock** dashboard widget.\n\n' +
  '- **Default** — follow the global default in **Settings → Inventory** (watched at that ' +
  'level if it’s on, silent if it’s off).\n' +
  '- **Custom** — flag it at or below your own percentage remaining.\n' +
  '- **Never** — a hard exemption: this item is never flagged, even if a global default is set.';

/**
 * "N on order" line shown beside the reorder point (open ORDERED/PARTIAL POs). Surfacing it
 * here makes the relationship legible in one place: you're below your reorder point, but this
 * much is already inbound — the low-stock alert itself deliberately stays on-hand-based, so a
 * covered item still shows as low here, just with the incoming stock in view.
 */
function OnOrderNote({ itemId }: { itemId: string }) {
  const onOrderQty = useOnOrderQty(itemId).data ?? 0;
  if (onOrderQty <= 0) return null;
  return (
    <Tooltip
      content="Units already **on order** on an open purchase order — inbound but not yet received, so not counted in on-hand stock or the low-stock alert."
      openDelayMs={INFO_OPEN_DELAY_MS}
    >
      <p
        className="flex items-center gap-1.5 text-xs font-medium text-primary [&_svg]:size-3.5"
        data-testid="reorder-on-order"
      >
        <TruckIcon aria-hidden />
        <span>{onOrderQty} on order</span>
      </p>
    </Tooltip>
  );
}

function DiscreteReorderEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const globalDefault = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const labelId = useId();

  const [policy, setPolicy] = useState<LowStockPolicy>(policyFromValue(item.reorderPoint));
  const [point, setPoint] = useState(
    item.reorderPoint && item.reorderPoint > 0 ? String(item.reorderPoint) : '',
  );
  const [topUp, setTopUp] = useState(item.reorderQty?.toString() ?? '');

  // Re-sync the draft when the persisted values change (open, after a save, or sync).
  useEffect(() => {
    setPolicy(policyFromValue(item.reorderPoint));
    setPoint(item.reorderPoint && item.reorderPoint > 0 ? String(item.reorderPoint) : '');
    setTopUp(item.reorderQty?.toString() ?? '');
  }, [item.reorderPoint, item.reorderQty]);

  // Choosing "Custom" seeds a friendly suggestion so the revealed field is never blank.
  const changePolicy = (next: LowStockPolicy) => {
    setPolicy(next);
    if (next === 'custom' && !point.trim()) setPoint(String(LOW_STOCK_QTY_SUGGESTED));
  };

  const customPoint = toValue(point);
  const targetPoint = valueForPolicy(policy, customPoint);
  const targetTopUp = policy === 'custom' ? toValue(topUp) : null;
  const dirty = targetPoint !== (item.reorderPoint ?? null) || targetTopUp !== (item.reorderQty ?? null);
  const invalid = customInvalid(policy, customPoint);
  // Let the dialog frame ask before discarding the draft on a dismissal (issue #576) — reported
  // on exactly the flag the Save button below is driven by, so the two never disagree.
  useReportUnsavedChanges(dirty && !invalid);

  const save = () =>
    update.mutate({ id: item.id, input: { reorderPoint: targetPoint, reorderQty: targetTopUp } });

  const defaultLabel =
    globalDefault > 0
      ? `This item follows the global default — ${globalDefault} units — set in Settings.`
      : 'This item follows the global default, which is currently off (nothing is flagged).';

  return (
    <div className="space-y-3">
      <div className="space-y-field-gap-compact">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span id={labelId}>Low-stock alerts</span>
          <InfoHint content={DISCRETE_HINT} />
        </div>
        <LowStockPolicyPicker value={policy} onChange={changePolicy} labelledBy={labelId} />
      </div>

      {policy === 'custom' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium text-muted-foreground">
            <span className="mb-field-gap-compact block">Reorder point</span>
            <Input
              type="number"
              min={1}
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
      ) : (
        <PolicyNote policy={policy} defaultLabel={defaultLabel} />
      )}

      <OnOrderNote itemId={item.id} />

      <SaveButton dirty={dirty && !invalid} pending={update.isPending} onClick={save} />
    </div>
  );
}

function GaugeReorderEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const globalDefault = usePreferencesStore((s) => s.lowStockGaugePercent);
  const labelId = useId();

  const [policy, setPolicy] = useState<LowStockPolicy>(policyFromValue(item.reorderGaugePercent));
  const [percent, setPercent] = useState(
    item.reorderGaugePercent && item.reorderGaugePercent > 0 ? String(item.reorderGaugePercent) : '',
  );

  useEffect(() => {
    setPolicy(policyFromValue(item.reorderGaugePercent));
    setPercent(
      item.reorderGaugePercent && item.reorderGaugePercent > 0 ? String(item.reorderGaugePercent) : '',
    );
  }, [item.reorderGaugePercent]);

  const changePolicy = (next: LowStockPolicy) => {
    setPolicy(next);
    if (next === 'custom' && !percent.trim()) setPercent(String(LOW_STOCK_GAUGE_SUGGESTED));
  };

  const customPercent = toValue(percent);
  const targetPercent = valueForPolicy(policy, customPercent);
  const dirty = targetPercent !== (item.reorderGaugePercent ?? null);
  const invalid = customInvalid(policy, customPercent);
  // As above: the close guard and the Save button read the same flag (issue #576).
  useReportUnsavedChanges(dirty && !invalid);

  const save = () => update.mutate({ id: item.id, input: { reorderGaugePercent: targetPercent } });

  const defaultLabel =
    globalDefault > 0
      ? `This item follows the global default — ${globalDefault}% — set in Settings.`
      : 'This item follows the global default, which is currently off (nothing is flagged).';

  return (
    <div className="space-y-3">
      <div className="space-y-field-gap-compact">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span id={labelId}>Low-stock alerts</span>
          <InfoHint content={GAUGE_HINT} />
        </div>
        <LowStockPolicyPicker value={policy} onChange={changePolicy} labelledBy={labelId} />
      </div>

      {policy === 'custom' ? (
        <label className="block max-w-[14rem] text-xs font-medium text-muted-foreground">
          <span className="mb-field-gap-compact block">Reorder at (% remaining)</span>
          <Input
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            placeholder={`e.g. ${LOW_STOCK_GAUGE_SUGGESTED}`}
            aria-label="Reorder gauge percentage"
            data-testid="reorder-gauge-input"
          />
        </label>
      ) : (
        <PolicyNote policy={policy} defaultLabel={defaultLabel} />
      )}

      <SaveButton dirty={dirty && !invalid} pending={update.isPending} onClick={save} />
    </div>
  );
}
