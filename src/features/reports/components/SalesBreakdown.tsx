import { AnimatedNumber, Money } from '@/components/foundry';
import type { Formatters } from '@/lib/format';
import type { SalesGroup, SalesReport } from '../sales-analytics';

/** How many category rows to show before collapsing the long tail. */
const TOP_N = 6;

/** A token-styled labelled bar: name on the left, amount + share on the right, a scaled fill. */
function SalesBar({
  name,
  total,
  share,
  max,
  formatters,
}: {
  name: string;
  total: number;
  share: number;
  max: number;
  formatters: Formatters;
}) {
  const widthPercent = max > 0 ? Math.max(2, Math.round((total / max) * 100)) : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          <Money value={total} formatters={formatters} /> · {Math.round(share * 100)}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-emphasized"
          style={{ width: `${widthPercent}%` }}
        />
      </div>
    </li>
  );
}

/** Collapse the tail beyond {@link TOP_N} into a single "Other" row so the list stays scannable. */
function topWithOther(groups: readonly SalesGroup[]): SalesGroup[] {
  if (groups.length <= TOP_N) return [...groups];
  const head = groups.slice(0, TOP_N);
  const tail = groups.slice(TOP_N);
  return [
    ...head,
    {
      id: null,
      name: `Other (${tail.length})`,
      proceeds: tail.reduce((sum, g) => sum + g.proceeds, 0),
      cogs: tail.reduce((sum, g) => sum + g.cogs, 0),
      margin: tail.reduce((sum, g) => sum + g.margin, 0),
      share: tail.reduce((sum, g) => sum + g.share, 0),
    },
  ];
}

/** A headline figure: a caption over a Money value, sharing the tabular alignment. */
function Stat({
  caption,
  value,
  formatters,
  emphasised = false,
}: {
  caption: string;
  value: number;
  formatters: Formatters;
  emphasised?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{caption}</span>
      <Money
        value={value}
        formatters={formatters}
        animate
        animateOnMount
        className={emphasised ? 'text-lg font-semibold' : 'text-base font-medium'}
      />
    </div>
  );
}

/**
 * The sales & disposals breakdown: headline proceeds / COGS / margin, sale proceeds over time
 * (a bucket bar strip), sales by category, and the write-off total. Tokens only, no chart
 * dependency (§2.4.3); every bar labels its amount + share in text. The margin excludes any units
 * sold without a recorded cost — surfaced as a caveat rather than silently overstating the figure.
 */
export function SalesBreakdown({ report, formatters }: { report: SalesReport; formatters: Formatters }) {
  const hasActivity = report.saleCount > 0 || report.writeOffCount > 0;
  if (!hasActivity) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground" data-testid="sales-empty">
        No sales or write-offs recorded in this window.
      </p>
    );
  }

  const bucketMax = Math.max(...report.buckets.map((b) => b.proceeds), 0);
  const categories = topWithOther(report.byCategory);

  return (
    <div className="flex flex-col gap-6" data-testid="sales-breakdown">
      {/* Headline figures. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat caption="Proceeds" value={report.proceeds} formatters={formatters} emphasised />
        <Stat caption="Cost of goods" value={report.cogs} formatters={formatters} />
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Gross margin</span>
          <span className="flex items-baseline gap-1.5">
            <Money
              value={report.margin}
              formatters={formatters}
              animate
              animateOnMount
              className="text-lg font-semibold"
            />
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.round(report.marginPct * 100)}%
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Units sold</span>
          <AnimatedNumber value={report.unitsSold} className="text-lg font-semibold" animateOnMount />
        </div>
      </div>

      {report.unitsWithoutCost > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="sales-cost-caveat">
          Margin excludes {report.unitsWithoutCost} sold {report.unitsWithoutCost === 1 ? 'unit' : 'units'}{' '}
          with no recorded cost.
        </p>
      )}

      {/* Proceeds over time — one bar per bucket, scaled to the busiest bucket. */}
      {report.proceeds > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Proceeds over time</span>
          <div className="flex h-20 items-end gap-0.5" aria-hidden="true" data-testid="sales-over-time">
            {report.buckets.map((b) => {
              const heightPercent =
                bucketMax > 0 ? Math.max(2, Math.round((b.proceeds / bucketMax) * 100)) : 0;
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
      )}

      {report.byCategory.length > 0 && (
        <section aria-labelledby="sales-category-heading" className="flex flex-col gap-2">
          <h4 id="sales-category-heading" className="text-sm font-semibold">
            Sales by category
          </h4>
          <ul className="flex flex-col gap-3">
            {categories.map((g) => (
              <SalesBar
                key={g.id ?? g.name}
                name={g.name}
                total={g.proceeds}
                share={g.share}
                max={categories[0]?.proceeds ?? 0}
                formatters={formatters}
              />
            ))}
          </ul>
        </section>
      )}

      {report.writeOffCount > 0 && (
        <div
          className="flex items-baseline justify-between gap-3 border-t border-border pt-4"
          data-testid="sales-writeoffs"
        >
          <span className="text-sm text-muted-foreground">
            Written off ({report.writeOffUnits} {report.writeOffUnits === 1 ? 'unit' : 'units'})
          </span>
          <Money
            value={report.writeOffValue}
            formatters={formatters}
            animate
            animateOnMount
            className="font-medium"
          />
        </div>
      )}
    </div>
  );
}
