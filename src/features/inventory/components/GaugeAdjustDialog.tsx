import { useState } from 'react';
import { Button, Input, Modal } from '@/components/foundry';
import { cn } from '@/lib/utils';
import type { Item } from '@/db/repositories';
import {
  clampNetValue,
  refillDelta,
  refillNote,
  refillToFullAmount,
  weighInNote,
  weighInToDelta,
} from '@/db/repositories/gauge';
import { useFormatters } from '@/lib/useFormatters';
import { useAdjustGauge } from '../mutations';
import { GaugeBar } from './GaugeBar';

type Mode = 'consume' | 'weighin' | 'refill';

/**
 * Consumable-Gauge update dialog (spec §4.1.2). Offers three interaction modes:
 * Relative "Consumption" (user knows how much they used), Absolute "Weigh-In"
 * (user reads the total gross weight off a scale), and "Refill" (mounting a fresh
 * spool / topping up — the inverse of consumption, capped at a full unit).
 * Crucially, every mode is converted to a *relative delta here in the React layer*
 * before the mutation, so only the delta reaches the database and Activity Log —
 * the CRDT integrity rule.
 */
export function GaugeAdjustDialog({
  item,
  open,
  onClose,
}: {
  item: Item;
  open: boolean;
  onClose: () => void;
}) {
  const adjust = useAdjustGauge();
  const fmt = useFormatters();
  const [mode, setMode] = useState<Mode>('consume');
  const [value, setValue] = useState('');

  const gauge = item.gauge;
  if (!gauge) return null;

  const numeric = Number.parseFloat(value);
  const valid = Number.isFinite(numeric) && numeric >= 0;

  const delta = !valid
    ? 0
    : mode === 'consume'
      ? -numeric
      : mode === 'weighin'
        ? weighInToDelta(numeric, gauge.currentNetValue, gauge.tareWeight)
        : refillDelta(numeric, gauge.currentNetValue, gauge.grossCapacity);

  const projectedNet = clampNetValue(gauge.currentNetValue + delta, gauge.grossCapacity);

  const submit = () => {
    if (!valid || delta === 0) return;
    const note =
      mode === 'weighin'
        ? weighInNote(numeric, delta, gauge.unitOfMeasure)
        : mode === 'refill'
          ? refillNote(delta, projectedNet, gauge.unitOfMeasure)
          : undefined;
    adjust.mutate(
      { id: item.id, adjustment: { delta, note } },
      {
        onSuccess: () => {
          setValue('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={`Update ${item.name}`} description="Record usage or recalibrate against a scale.">
      <div className="mb-4">
        <GaugeBar gauge={gauge} />
      </div>

      <div className="mb-4 grid grid-cols-3 gap-2">
        <ModeButton active={mode === 'consume'} onClick={() => setMode('consume')} title="Consumption" subtitle="I know how much I used" />
        <ModeButton active={mode === 'weighin'} onClick={() => setMode('weighin')} title="Weigh-In" subtitle="Read total off a scale" />
        <ModeButton active={mode === 'refill'} onClick={() => setMode('refill')} title="Refill" subtitle="Topped up / fresh unit" testid="gauge-mode-refill" />
      </div>

      <label className="block text-sm font-medium" htmlFor="gauge-value">
        {mode === 'consume'
          ? `Amount used (${gauge.unitOfMeasure})`
          : mode === 'weighin'
            ? `Gross weight on scale (${gauge.unitOfMeasure})`
            : `Amount added (${gauge.unitOfMeasure})`}
      </label>
      <Input
        id="gauge-value"
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        className="mt-1.5"
        placeholder={mode === 'weighin' ? String(gauge.currentGrossWeight) : '0'}
      />

      {mode === 'refill' ? (
        <button
          type="button"
          data-testid="gauge-fill-full"
          onClick={() => setValue(String(refillToFullAmount(gauge.currentNetValue, gauge.grossCapacity)))}
          className="mt-2 text-xs font-medium text-primary hover:underline"
        >
          Fill to full ({fmt.measure(refillToFullAmount(gauge.currentNetValue, gauge.grossCapacity), gauge.unitOfMeasure)})
        </button>
      ) : null}

      {valid && delta !== 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {mode === 'weighin' ? (
            <>
              Tare {fmt.measure(gauge.tareWeight, gauge.unitOfMeasure)} ·{' '}
              <span className="font-medium text-foreground">
                Calculated change {delta > 0 ? '+' : ''}
                {fmt.measure(delta, gauge.unitOfMeasure)}
              </span>
            </>
          ) : (
            <>
              New net level:{' '}
              <span className="font-medium text-foreground">
                {fmt.measure(projectedNet, gauge.unitOfMeasure)}
              </span>
            </>
          )}
        </p>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button data-testid="gauge-apply" onClick={submit} disabled={!valid || delta === 0 || adjust.isPending}>
          Apply update
        </Button>
      </div>
    </Modal>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  subtitle,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  testid?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={cn(
        'rounded-xl border p-3 text-left transition-all',
        active
          ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
          : 'border-border bg-secondary/30 hover:bg-secondary/50',
      )}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="block text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}
