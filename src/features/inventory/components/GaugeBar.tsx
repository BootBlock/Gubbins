import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { GaugeState } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useReducedMotion } from '@/components/foundry';
import { gaugeTone } from './inventory-ui';

/**
 * Mount-entrance flag: starts `false` so the gauge can render at its "empty"
 * baseline on first paint, then flips `true` after mount so the existing CSS
 * transition plays the fill from 0 → value. With reduced motion preferred we
 * skip the empty baseline entirely and render the final value immediately, so
 * there is never a flash (the global CSS catch-all already zeroes the duration).
 */
function useMountFill(reduced: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return reduced || mounted;
}

/**
 * Consumable-Gauge visualisation (spec §4.1.3): a fluid linear progress bar whose
 * colour transitions green → amber → crimson as the remaining percentage falls,
 * with smooth width/colour animation as the value shifts.
 */
export function GaugeBar({ gauge, showLabels = true }: { gauge: GaugeState; showLabels?: boolean }) {
  const pct = Math.max(0, Math.min(100, gauge.percentageRemaining));
  const tone = gaugeTone(pct);
  const fmt = useFormatters();
  // On first mount the fill starts at 0 and transitions up to `pct`; `aria-valuenow`
  // always reports the true `pct`, never the transient 0.
  const filled = useMountFill(useReducedMotion());

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
          style={{ width: `${filled ? pct : 0}%` }}
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
 */
export function GaugeRing({ gauge, size = 40 }: { gauge: GaugeState; size?: number }) {
  const pct = Math.max(0, Math.min(100, gauge.percentageRemaining));
  const tone = gaugeTone(pct);
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  // On first mount the ring starts empty (full-circumference offset) and the existing
  // transition sweeps the stroke up to its real `offset`.
  const filled = useMountFill(useReducedMotion());

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
        strokeDashoffset={filled ? offset : circumference}
        className={cn('stroke-current transition-all duration-500 ease-emphasized', tone.text)}
      />
    </svg>
  );
}
