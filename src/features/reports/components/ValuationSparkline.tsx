import type { Formatters } from '@/lib/format';
import type { ValuationTrendReport } from '../valuation-trend';

/** SVG viewBox dimensions — a wide, short sparkline strip. Stroke-only, so units are arbitrary. */
const VIEW_W = 100;
const VIEW_H = 32;
const PAD = 2;

/**
 * A hand-rolled SVG sparkline of the reconstructed inventory-value trend (no chart dependency,
 * §2.4.3) — a single polyline over the `primary` token, with the start/end values and the net
 * change (tinted by sign with the `success`/`destructive` tokens) read in text beside it. The
 * line is decorative (`aria-hidden`); the textual figures carry the accessible summary.
 */
export function ValuationSparkline({
  report,
  formatters,
}: {
  report: ValuationTrendReport;
  formatters: Formatters;
}) {
  const values = report.points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  const n = report.points.length;

  // Map each point into the padded viewBox. A flat line (range 0) sits on the vertical centre.
  const coords = report.points.map((p, i) => {
    const x = n > 1 ? PAD + (i / (n - 1)) * (VIEW_W - 2 * PAD) : VIEW_W / 2;
    const y =
      range > 0
        ? VIEW_H - PAD - ((p.value - min) / range) * (VIEW_H - 2 * PAD)
        : VIEW_H / 2;
    return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
  });

  const rising = report.changeValue >= 0;

  return (
    <div className="flex flex-col gap-3" data-testid="valuation-sparkline">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        aria-hidden="true"
      >
        <polyline
          points={coords.join(' ')}
          fill="none"
          className="stroke-primary"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span className="text-muted-foreground">
          Start <span className="font-medium text-foreground tabular-nums">{formatters.currency(report.startValue)}</span>
        </span>
        <span className="text-muted-foreground">
          Now <span className="font-medium text-foreground tabular-nums">{formatters.currency(report.endValue)}</span>
        </span>
        <span className={`font-medium tabular-nums ${rising ? 'text-success' : 'text-destructive'}`}>
          {rising ? '+' : '−'}
          {formatters.currency(Math.abs(report.changeValue))}
        </span>
      </div>
    </div>
  );
}
