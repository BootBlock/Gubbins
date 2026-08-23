import { useRef, useState } from 'react';
import { Button, Input, Modal, optionCardClassName, useRovingRadioGroup } from '@/components/foundry';
import { cn } from '@/lib/utils';
import type { Item } from '@/db/repositories';
import {
  attritionDraw,
  attritionNote,
  clampNetValue,
  estimateDelta,
  estimateNote,
  GAUGE_LEVELS,
  refillDelta,
  refillNote,
  refillToFullAmount,
  weighInNote,
  weighInToDelta,
  type GaugeLevelKey,
} from '@/db/repositories/gauge';
import { useFormatters } from '@/lib/useFormatters';
import { useAdjustGauge } from '../mutations';
import { GaugeBar, GaugeRing } from './GaugeBar';

type Mode = 'consume' | 'weighin' | 'refill' | 'estimate';

/**
 * Consumable-Gauge update dialog (spec §4.1.2). Offers four interaction modes:
 * Relative "Consumption" (user knows how much they used), Absolute "Weigh-In"
 * (user reads the total gross weight off a scale), "Refill" (mounting a fresh
 * spool / topping up — the inverse of consumption, capped at a full unit), and
 * "Estimate" (issue #95 — no scale, just pick a fill level: Full…Empty, snapping
 * the gauge to that coefficient of capacity). Crucially, every mode is converted to
 * a *relative delta here in the React layer* before the mutation, so only the delta
 * reaches the database and Activity Log — the CRDT integrity rule.
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
  const [level, setLevel] = useState<GaugeLevelKey | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  const gauge = item.gauge;
  if (!gauge) return null;

  const numeric = Number.parseFloat(value);
  const numericValid = Number.isFinite(numeric) && numeric >= 0;

  const selectedLevel = mode === 'estimate' ? (GAUGE_LEVELS.find((l) => l.key === level) ?? null) : null;

  // Attrition (issue #89) applies to Consumption only. Weigh-In already measures what is
  // physically left, so waste is baked into its reading — taxing it again would double-count.
  // Refill and Estimate are not draws at all.
  const draw = mode === 'consume' && numericValid ? attritionDraw(numeric, gauge.attritionPercent) : null;
  const hasAttrition = draw !== null && draw.waste > 0;

  // Every mode resolves to a signed net-value delta; only the delta is persisted.
  const valid = mode === 'estimate' ? selectedLevel !== null : numericValid;
  const delta = !valid
    ? 0
    : mode === 'estimate'
      ? estimateDelta(selectedLevel!.percent, gauge.currentNetValue, gauge.grossCapacity)
      : mode === 'consume'
        ? -(draw?.total ?? numeric)
        : mode === 'weighin'
          ? weighInToDelta(numeric, gauge.currentNetValue, gauge.tareWeight)
          : refillDelta(numeric, gauge.currentNetValue, gauge.grossCapacity);

  const projectedNet = clampNetValue(gauge.currentNetValue + delta, gauge.grossCapacity);

  const submit = () => {
    if (!valid || delta === 0) return;
    const note =
      mode === 'estimate'
        ? estimateNote(selectedLevel!.label, selectedLevel!.percent, projectedNet, gauge.unitOfMeasure)
        : mode === 'weighin'
          ? weighInNote(numeric, delta, gauge.unitOfMeasure)
          : mode === 'refill'
            ? refillNote(delta, projectedNet, gauge.unitOfMeasure)
            : hasAttrition
              ? attritionNote(draw, gauge.unitOfMeasure)
              : undefined;
    adjust.mutate(
      {
        id: item.id,
        adjustment: {
          delta,
          note,
          ...(hasAttrition ? { attrition: { requested: draw.requested, waste: draw.waste } } : {}),
        },
      },
      {
        onSuccess: () => {
          setValue('');
          setLevel(null);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Update ${item.name}`}
      description="Record usage or recalibrate against a scale."
      initialFocusRef={valueRef}
    >
      {/* At-a-glance ring (draws on once as the dialog opens — a mount-once surface, so the
          one-shot sweep never re-fires the way it would on a recycled list row) beside the
          precise net/gross bar. */}
      <div className="mb-4 flex items-center gap-4">
        <GaugeRing gauge={gauge} size={56} drawOn />
        <div className="min-w-0 flex-1">
          <GaugeBar gauge={gauge} />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <ModeButton
          active={mode === 'consume'}
          onClick={() => setMode('consume')}
          title="Consumption"
          subtitle="I know how much I used"
        />
        <ModeButton
          active={mode === 'weighin'}
          onClick={() => setMode('weighin')}
          title="Weigh-In"
          subtitle="Read total off a scale"
        />
        <ModeButton
          active={mode === 'refill'}
          onClick={() => setMode('refill')}
          title="Refill"
          subtitle="Topped up / fresh unit"
          testid="gauge-mode-refill"
        />
        <ModeButton
          active={mode === 'estimate'}
          onClick={() => setMode('estimate')}
          title="Estimate"
          subtitle="No scale — eyeball it"
          testid="gauge-mode-estimate"
        />
      </div>

      {mode === 'estimate' ? (
        <LevelSlider value={level} onChange={setLevel} />
      ) : (
        <>
          <label className="block text-sm font-medium" htmlFor="gauge-value">
            {mode === 'consume'
              ? `Amount used (${gauge.unitOfMeasure})`
              : mode === 'weighin'
                ? `Gross weight on scale (${gauge.unitOfMeasure})`
                : `Amount added (${gauge.unitOfMeasure})`}
          </label>
          <Input
            ref={valueRef}
            id="gauge-value"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
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
              Fill to full (
              {fmt.measure(
                refillToFullAmount(gauge.currentNetValue, gauge.grossCapacity),
                gauge.unitOfMeasure,
              )}
              )
            </button>
          ) : null}
        </>
      )}

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
              {/* Attrition must be visible *before* committing — the whole feature turns a
                  number the user typed into a larger one, and a silent multiplier reads as a
                  bug. Naming both figures is what makes it legible. */}
              {hasAttrition ? (
                <span className="block" data-testid="gauge-attrition-preview">
                  Using {fmt.measure(draw.requested, gauge.unitOfMeasure)} costs{' '}
                  <span className="font-medium text-foreground">
                    {fmt.measure(draw.total, gauge.unitOfMeasure)}
                  </span>{' '}
                  ({fmt.measure(draw.waste, gauge.unitOfMeasure)} waste at {gauge.attritionPercent}%)
                </span>
              ) : null}
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
        <Button
          data-testid="gauge-apply"
          onClick={submit}
          disabled={!valid || delta === 0 || adjust.isPending}
        >
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
      className={optionCardClassName(active, 'compact')}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="block text-xs text-muted-foreground">{subtitle}</span>
    </button>
  );
}

/**
 * The "Estimate" fill-level picker (issue #95) — a five-stop slider from Full to Empty
 * rendered as an accessible WAI-ARIA `radiogroup` with roving `tabindex`: a single tab
 * stop, arrow keys move *and* select, Home/End jump to the ends. It starts unselected
 * (the current gauge rarely lands exactly on a stop) so the user makes a deliberate
 * choice; the first stop is the tab entry point until one is picked.
 */
function LevelSlider({
  value,
  onChange,
}: {
  value: GaugeLevelKey | null;
  onChange: (level: GaugeLevelKey) => void;
}) {
  const selectedIndex = GAUGE_LEVELS.findIndex((l) => l.key === value);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: GAUGE_LEVELS.length,
    onSelect: (index) => onChange(GAUGE_LEVELS[index]!.key),
  });

  return (
    <>
      <span id="gauge-level-label" className="block text-sm font-medium">
        How full is it?
      </span>
      {/* `overflow-hidden` is what clips the segments' square corners to the rounded group, so
          the ring is drawn *inside* the segment rather than bled outwards: a bleed here would
          give the corners back their squareness. The segments' `z-10` went with it — a z-index
          cannot lift anything out of an ancestor's overflow clip (#417). */}
      <div
        role="radiogroup"
        aria-labelledby="gauge-level-label"
        className="mt-1.5 flex overflow-hidden rounded-xl border border-border"
      >
        {GAUGE_LEVELS.map((option, index) => {
          const checked = index === selectedIndex;
          return (
            <button
              key={option.key}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === tabbableIndex ? 0 : -1}
              onClick={() => selectAt(index)}
              onKeyDown={(e) => onKeyDown(e, index)}
              data-testid={`gauge-level-${option.key}`}
              className={cn(
                'flex-1 border-r border-border px-1 py-2 text-center outline-none transition-colors last:border-r-0',
                'focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring',
                checked
                  ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary'
                  : 'bg-secondary/30 text-muted-foreground hover:bg-secondary/50',
              )}
            >
              <span className="block text-xs font-semibold leading-tight">{option.label}</span>
              <span className="block text-[0.65rem] text-muted-foreground">{option.percent}%</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
