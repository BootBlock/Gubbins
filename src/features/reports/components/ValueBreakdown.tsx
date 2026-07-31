import { Money, ShowMore, useProgressiveReveal } from '@/components/foundry';
import type { Formatters } from '@/lib/format';
import type { ValueGroup } from '../reports';

/** How many groups the breakdown opens with, and how many each "show more" adds. */
export const VALUE_BREAKDOWN_INITIAL_GROUPS = 12;

/**
 * A token-styled horizontal bar breakdown of inventory value by group (category or
 * location). Each bar's width is the group's share of the largest group's value, so the
 * relative magnitudes read at a glance without a chart dependency (§2.4.3 native-first —
 * just Tailwind + the `primary` token). Zero-value groups still list, with an empty bar.
 *
 * Only the leading {@link VALUE_BREAKDOWN_INITIAL_GROUPS} groups are drawn at first — a valuation
 * with a hundred categories is a wall rather than a breakdown — but the rest are never silently
 * dropped (issue #609): the `ShowMore` footer says how many of how many are on screen and reveals
 * the remainder. The bars stay scaled against the largest group in the *whole* set, so a revealed
 * row has the width it would always have had.
 */
export function ValueBreakdown({
  groups,
  formatters,
  label,
  emptyLabel,
}: {
  groups: readonly ValueGroup[];
  formatters: Formatters;
  /** Localised plural noun for the rows ("categories", "locations") — names the list in the footer. */
  label: string;
  emptyLabel: string;
}) {
  const reveal = useProgressiveReveal(groups.length, { initial: VALUE_BREAKDOWN_INITIAL_GROUPS });

  if (groups.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const max = Math.max(...groups.map((g) => g.value), 0);
  return (
    <div className="flex flex-col gap-3" data-testid="value-breakdown">
      <ul className="flex flex-col gap-3">
        {groups.slice(0, reveal.limit).map((group) => {
          const fraction = max > 0 ? group.value / max : 0;
          const widthPercent = Math.max(2, Math.round(fraction * 100));
          return (
            <li key={group.id ?? 'ungrouped'} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium">{group.name}</span>
                <Money
                  value={group.value}
                  formatters={formatters}
                  className="shrink-0 text-muted-foreground"
                />
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500 ease-emphasized"
                  style={{ width: `${widthPercent}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <ShowMore
        shown={reveal.limit}
        total={groups.length}
        label={label}
        expanded={reveal.expanded}
        onShowMore={reveal.showMore}
        onShowLess={reveal.showLess}
        data-testid="value-breakdown-more"
      />
    </div>
  );
}
