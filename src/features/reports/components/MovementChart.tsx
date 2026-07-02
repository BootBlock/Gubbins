import type { Formatters } from '@/lib/format';
import type { MovementReport } from '../reports';

/**
 * A token-styled stock-movement chart: one column per time bucket, each holding two stacked
 * bars — stock **in** (the `success` token) above the baseline and stock **out** (the
 * `destructive` token) below it. Heights are scaled to the largest single in/out magnitude
 * across the window. Composed with Tailwind + tokens only (no chart dependency, §2.4.3); the
 * legend and totals give the accessible non-visual summary.
 */
export function MovementChart({ report, formatters }: { report: MovementReport; formatters: Formatters }) {
  const peak = Math.max(1, ...report.buckets.map((b) => Math.max(b.in, b.out)));

  if (report.totalIn === 0 && report.totalOut === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">No stock movement in this window.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-success" aria-hidden="true" />
          In {formatters.quantity(report.totalIn)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-destructive" aria-hidden="true" />
          Out {formatters.quantity(report.totalOut)}
        </span>
      </div>

      <div className="flex h-40 items-stretch gap-1" data-testid="movement-chart">
        {report.buckets.map((bucket, i) => {
          const inPercent = Math.round((bucket.in / peak) * 100);
          const outPercent = Math.round((bucket.out / peak) * 100);
          const title = `${formatters.date(bucket.start)}: in ${formatters.quantity(
            bucket.in,
          )}, out ${formatters.quantity(bucket.out)}`;
          return (
            <div key={i} className="flex flex-1 flex-col" title={title}>
              {/* In — grows up from the centre baseline. */}
              <div className="flex flex-1 flex-col justify-end">
                <div
                  className="rounded-t-sm bg-success transition-[height] duration-500 ease-emphasized"
                  style={{ height: `${inPercent}%` }}
                />
              </div>
              <div className="h-px bg-border" aria-hidden="true" />
              {/* Out — grows down from the centre baseline. */}
              <div className="flex flex-1 flex-col justify-start">
                <div
                  className="rounded-b-sm bg-destructive transition-[height] duration-500 ease-emphasized"
                  style={{ height: `${outPercent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
