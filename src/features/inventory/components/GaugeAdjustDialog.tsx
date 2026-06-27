import { useState } from 'react';
import { Button, Input, Modal } from '@/components/foundry';
import { cn } from '@/lib/utils';
import type { Item } from '@/db/repositories';
import { weighInNote, weighInToDelta } from '@/db/repositories/gauge';
import { useAdjustGauge } from '../mutations';
import { formatMeasure } from './inventory-ui';
import { GaugeBar } from './GaugeBar';

type Mode = 'consume' | 'weighin';

/**
 * Consumable-Gauge update dialog (spec §4.1.2). Offers both interaction modes:
 * Relative "Consumption" (user knows how much they used) and Absolute "Weigh-In"
 * (user reads the total gross weight off a scale). Crucially, the weigh-in is
 * converted to a *relative delta here in the React layer* before the mutation, so
 * only the delta reaches the database and Activity Log — the CRDT integrity rule.
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
      : weighInToDelta(numeric, gauge.currentNetValue, gauge.tareWeight);

  const projectedNet = Math.max(0, gauge.currentNetValue + delta);

  const submit = () => {
    if (!valid || delta === 0) return;
    const note =
      mode === 'weighin' ? weighInNote(numeric, delta, gauge.unitOfMeasure) : undefined;
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

      <div className="mb-4 grid grid-cols-2 gap-2">
        <ModeButton active={mode === 'consume'} onClick={() => setMode('consume')} title="Consumption" subtitle="I know how much I used" />
        <ModeButton active={mode === 'weighin'} onClick={() => setMode('weighin')} title="Weigh-In" subtitle="Read total off a scale" />
      </div>

      <label className="block text-sm font-medium" htmlFor="gauge-value">
        {mode === 'consume'
          ? `Amount used (${gauge.unitOfMeasure})`
          : `Gross weight on scale (${gauge.unitOfMeasure})`}
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

      {valid && delta !== 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {mode === 'weighin' ? (
            <>
              Tare {formatMeasure(gauge.tareWeight, gauge.unitOfMeasure)} ·{' '}
              <span className="font-medium text-foreground">
                Calculated change {delta > 0 ? '+' : ''}
                {formatMeasure(delta, gauge.unitOfMeasure)}
              </span>
            </>
          ) : (
            <>
              New net level:{' '}
              <span className="font-medium text-foreground">
                {formatMeasure(projectedNet, gauge.unitOfMeasure)}
              </span>
            </>
          )}
        </p>
      ) : null}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid || delta === 0 || adjust.isPending}>
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
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
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
