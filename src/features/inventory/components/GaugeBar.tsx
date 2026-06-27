import { cn } from '@/lib/utils';
import type { GaugeState } from '@/db/repositories';
import { formatMeasure, gaugeTone } from './inventory-ui';

/**
 * Consumable-Gauge visualisation (spec §4.1.3): a fluid linear progress bar whose
 * colour transitions green → amber → crimson as the remaining percentage falls,
 * with smooth width/colour animation as the value shifts.
 */
export function GaugeBar({ gauge, showLabels = true }: { gauge: GaugeState; showLabels?: boolean }) {
  const pct = Math.max(0, Math.min(100, gauge.percentageRemaining));
  const tone = gaugeTone(pct);

  return (
    <div className="w-full">
      {showLabels ? (
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">
            {formatMeasure(gauge.currentNetValue, gauge.unitOfMeasure)} /{' '}
            {formatMeasure(gauge.grossCapacity, gauge.unitOfMeasure)}
          </span>
          <span className={cn('font-semibold tabular-nums', tone.text)}>{Math.round(pct)}%</span>
        </div>
      ) : null}
      <div className={cn('h-2.5 w-full overflow-hidden rounded-full', tone.track)}>
        <div
          className={cn('h-full rounded-full transition-all duration-500 ease-out', tone.fill)}
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
 */
export function GaugeRing({ gauge, size = 40 }: { gauge: GaugeState; size?: number }) {
  const pct = Math.max(0, Math.min(100, gauge.percentageRemaining));
  const tone = gaugeTone(pct);
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);

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
        className={cn('stroke-current transition-all duration-500 ease-out', tone.text)}
      />
    </svg>
  );
}
