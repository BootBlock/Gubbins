import type { Formatters } from '@/lib/format';
import type { SpendGroup, SpendReport } from '../spend-analytics';
import { SPEND_SOURCE_LABEL } from '../spend-analytics';

/** How many supplier / category rows to show before collapsing the long tail. */
const TOP_N = 6;

/** A token-styled labelled bar: name on the left, amount + share on the right, a scaled fill. */
function SpendBar({
  name,
  total,
  share,
  max,
  formatters,
  tone = 'bg-primary',
}: {
  name: string;
  total: number;
  share: number;
  max: number;
  formatters: Formatters;
  tone?: string;
}) {
  const widthPercent = max > 0 ? Math.max(2, Math.round((total / max) * 100)) : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatters.currency(total)} · {Math.round(share * 100)}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-emphasized ${tone}`}
          style={{ width: `${widthPercent}%` }}
        />
      </div>
    </li>
  );
}

/** Collapse the tail beyond {@link TOP_N} into a single "Other" row so the list stays scannable. */
function topWithOther(groups: readonly SpendGroup[]): SpendGroup[] {
  if (groups.length <= TOP_N) return [...groups];
  const head = groups.slice(0, TOP_N);
  const tailTotal = groups.slice(TOP_N).reduce((sum, g) => sum + g.total, 0);
  const tailShare = groups.slice(TOP_N).reduce((sum, g) => sum + g.share, 0);
  return [
    ...head,
    { id: null, name: `Other (${groups.length - TOP_N})`, total: tailTotal, share: tailShare },
  ];
}

/**
 * The Phase-79 spend-analytics breakdown: spend over time (a bucket bar strip), then by source,
 * by supplier and by category — each a scaled token bar list. Tokens only, no chart dependency
 * (§2.4.3); every bar labels its amount + share in text. Distinct from the Phase-74 valuation
 * trend: this is money *out*, not inventory value.
 */
export function SpendBreakdown({ report, formatters }: { report: SpendReport; formatters: Formatters }) {
  if (report.total <= 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground" data-testid="spend-empty">
        No spend recorded in this window.
      </p>
    );
  }

  const bucketMax = Math.max(...report.buckets.map((b) => b.total), 0);
  const suppliers = topWithOther(report.bySupplier);
  const categories = topWithOther(report.byCategory);

  return (
    <div className="flex flex-col gap-6" data-testid="spend-breakdown">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">Total spend</span>
        <span className="text-lg font-semibold tabular-nums">{formatters.currency(report.total)}</span>
      </div>

      {/* Spend over time — one bar per bucket, scaled to the busiest bucket. */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Over time</span>
        <div className="flex h-20 items-end gap-0.5" aria-hidden="true" data-testid="spend-over-time">
          {report.buckets.map((b) => {
            const heightPercent = bucketMax > 0 ? Math.max(2, Math.round((b.total / bucketMax) * 100)) : 0;
            return (
              <div
                key={b.start}
                className="flex-1 rounded-t bg-primary/70 transition-[height] duration-500 ease-emphasized"
                style={{ height: `${heightPercent}%` }}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{formatters.date(report.windowStart)}</span>
          <span>{formatters.date(report.windowEnd)}</span>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="spend-source-heading" className="flex flex-col gap-2">
          <h4 id="spend-source-heading" className="text-sm font-semibold">
            By source
          </h4>
          <ul className="flex flex-col gap-3">
            {report.bySource.map((s) => (
              <SpendBar
                key={s.source}
                name={SPEND_SOURCE_LABEL[s.source]}
                total={s.total}
                share={s.share}
                max={report.total}
                formatters={formatters}
              />
            ))}
          </ul>
        </section>

        <section aria-labelledby="spend-supplier-heading" className="flex flex-col gap-2">
          <h4 id="spend-supplier-heading" className="text-sm font-semibold">
            By supplier
          </h4>
          <ul className="flex flex-col gap-3">
            {suppliers.map((g) => (
              <SpendBar
                key={g.id ?? g.name}
                name={g.name}
                total={g.total}
                share={g.share}
                max={suppliers[0]?.total ?? 0}
                formatters={formatters}
              />
            ))}
          </ul>
        </section>

        <section aria-labelledby="spend-category-heading" className="flex flex-col gap-2 sm:col-span-2">
          <h4 id="spend-category-heading" className="text-sm font-semibold">
            By category
          </h4>
          <ul className="flex flex-col gap-3">
            {categories.map((g) => (
              <SpendBar
                key={g.id ?? g.name}
                name={g.name}
                total={g.total}
                share={g.share}
                max={categories[0]?.total ?? 0}
                formatters={formatters}
              />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
