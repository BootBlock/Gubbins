import type { Formatters } from '@/lib/format';
import type { AbcReport } from '../abc-analysis';

/** Static metadata for each tier: its swatch token utility and a plain-language gloss. */
const TIER_META: Record<'A' | 'B' | 'C', { swatch: string; gloss: string }> = {
  A: { swatch: 'bg-abc-a', gloss: 'Vital few' },
  B: { swatch: 'bg-abc-b', gloss: 'Important' },
  C: { swatch: 'bg-abc-c', gloss: 'Trivial many' },
};

/**
 * A token-styled ABC (Pareto) breakdown: the three tier roll-ups as share bars over the
 * `abc-a/b/c` palette, plus the highest-value items with their tier badge. The tier letter and
 * its share always read in text (colour is never the sole signal — WCAG 1.4.1), and the bars use
 * design tokens only (no chart dependency, §2.4.3). Empty when nothing has consumed value yet.
 */
export function AbcBreakdown({
  report,
  formatters,
  emptyLabel,
}: {
  report: AbcReport;
  formatters: Formatters;
  emptyLabel: string;
}) {
  if (report.totalValue <= 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const tiers = [report.tiers.A, report.tiers.B, report.tiers.C];

  return (
    <div className="flex flex-col gap-4" data-testid="abc-breakdown">
      <ul className="flex flex-col gap-3">
        {tiers.map((tier) => {
          const meta = TIER_META[tier.tier];
          const widthPercent = Math.max(2, Math.round(tier.valueShare * 100));
          return (
            <li key={tier.tier} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <span className={`size-2.5 rounded-sm ${meta.swatch}`} aria-hidden="true" />
                  Class {tier.tier}
                  <span className="text-xs font-normal text-muted-foreground">{meta.gloss}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatters.quantity(tier.itemCount)} items · {formatters.currency(tier.totalValue)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div
                  className={`h-full rounded-full ${meta.swatch} transition-[width] duration-500 ease-emphasized`}
                  style={{ width: `${widthPercent}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {formatters.percent(tier.valueShare)} of consumption value
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Top items by annual value
        </h3>
        <ul className="divide-y divide-border" data-testid="abc-top-items">
          {report.lines.slice(0, 8).map((line) => (
            <li key={line.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`inline-flex size-5 shrink-0 items-center justify-center rounded text-xs font-semibold text-primary-foreground ${TIER_META[line.tier].swatch}`}
                >
                  {line.tier}
                </span>
                <span className="min-w-0 truncate font-medium">{line.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatters.currency(line.annualValue)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
