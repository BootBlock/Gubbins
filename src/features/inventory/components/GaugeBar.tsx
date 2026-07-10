import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { GaugeState } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { gaugeTone, ringGeometry } from './inventory-ui';

/**
 * Consumable-Gauge visualisation (spec §4.1.3): a fluid linear progress bar whose
 * colour transitions green → amber → crimson as the remaining percentage falls.
 *
 * The bar renders at its true value on first paint (no mount-entrance sweep): the
 * `transition-all` only animates a *later* value change (e.g. a live gauge adjustment),
 * never the initial render. This is what keeps it safe inside the virtualised item grid —
 * a row scrolling back into view must not re-fire a fill animation (the same rule as the
 * F3 scroll-reveal / F7 tilt seams). `aria-valuenow` always reports the real `pct`.
 */
export function GaugeBar({ gauge, showLabels = true }: { gauge: GaugeState; showLabels?: boolean }) {
  const pct = Math.max(0, Math.min(100, gauge.percentageRemaining));
  const tone = gaugeTone(pct);
  const fmt = useFormatters();

  return (
    <div className="w-full">
      {showLabels ? (
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">
            {fmt.measure(gauge.currentNetValue, gauge.unitOfMeasure)} /{' '}
            {fmt.measure(gauge.grossCapacity, gauge.unitOfMeasure)}
          </span>
          <span className={cn('font-semibold tabular-nums', tone.text)}>{Math.round(pct)}%</span>
        </div>
      ) : null}
      <div className={cn('h-2.5 w-full overflow-hidden rounded-full', tone.track)}>
        <div
          className={cn('h-full rounded-full transition-all duration-500 ease-emphasized', tone.fill)}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

/**
 * Compact circular gauge for dense layouts — an SVG ring with the same colour
 * bands as {@link GaugeBar}.
 *
 * `drawOn` (visual-flair F8) opts the ring into a one-shot "draw-on": on mount its stroke
 * sweeps from empty to its value via `stroke-dashoffset` (compositor-friendly), settling with
 * `ease-emphasized`. It is **opt-in** precisely because the ring's usual home is the virtualised
 * item list, where rows recycle on scroll — arming the sweep there would re-fire it, so those
 * rings stay static (the default). Only pass `drawOn` on a mount-once surface (e.g. a dialog).
 * The sweep is pure CSS (`animate-ring-draw`); reduced motion snaps to the real value via the
 * global catch-all, so the ring always *rests* at its true `offset` regardless.
 */
export function GaugeRing({
  gauge,
  size = 40,
  drawOn = false,
}: {
  gauge: GaugeState;
  size?: number;
  /** One-shot stroke draw-on for mount-once surfaces. Never enable inside the virtualised list. */
  drawOn?: boolean;
}) {
  const stroke = 4;
  const { pct, radius, circumference, offset } = ringGeometry(gauge.percentageRemaining, size, stroke);
  const tone = gaugeTone(pct);
  // The draw-on keyframe animates `stroke-dashoffset` *from* the full circumference (empty ring),
  // read off this custom property; its implicit `to` is the real `offset` attribute below, which
  // the animation's `both` fill then holds. So the ring rests at its true value with or without
  // the sweep — the class only backfills the empty→value paint on a mount-once surface.
  const drawStyle = drawOn ? ({ '--gubbins-ring-circ': `${circumference}px` } as CSSProperties) : undefined;

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-current text-muted/40"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={drawStyle}
        className={cn(
          'stroke-current transition-all duration-500 ease-emphasized',
          drawOn && 'animate-ring-draw',
          tone.text,
        )}
      />
    </svg>
  );
}
