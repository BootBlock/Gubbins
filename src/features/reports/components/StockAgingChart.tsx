import type { Formatters } from '@/lib/format';
import type { StockAgingReport } from '../stock-aging';

/**
 * A token-styled stock-aging breakdown: one horizontal bar per age bucket, scaled to the
 * highest-value bucket so the share of capital in each age band reads at a glance. The
 * open-ended oldest bucket (`maxDays === null` — the slow-movers / dead stock) is tinted with
 * the `warning` token to flag it; the rest use `primary`. Tokens only, no chart dependency
 * (§2.4.3); each bar always labels its band, count, units and value in text.
 */
export function StockAgingChart({
  report,
  formatters,
}: {
  report: StockAgingReport;
  formatters: Formatters;
}) {
  if (report.totalQuantity <= 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">No stock on hand to age.</p>
    );
  }

  const max = Math.max(...report.buckets.map((b) => b.value), 0);

  return (
    <ul className="flex flex-col gap-3" data-testid="stock-aging-chart">
      {report.buckets.map((bucket) => {
        const fraction = max > 0 ? bucket.value / max : 0;
        const widthPercent = Math.max(2, Math.round(fraction * 100));
        const isOldest = bucket.maxDays === null;
        return (
          <li key={bucket.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{bucket.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatters.quantity(bucket.itemCount)} items · {formatters.quantity(bucket.quantity)} units ·{' '}
                {formatters.currency(bucket.value)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ease-emphasized ${
                  isOldest ? 'bg-warning' : 'bg-primary'
                }`}
                style={{ width: `${widthPercent}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
