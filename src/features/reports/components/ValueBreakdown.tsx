import type { Formatters } from '@/lib/format';
import type { ValueGroup } from '../reports';

/**
 * A token-styled horizontal bar breakdown of inventory value by group (category or
 * location). Each bar's width is the group's share of the largest group's value, so the
 * relative magnitudes read at a glance without a chart dependency (§2.4.3 native-first —
 * just Tailwind + the `primary` token). Zero-value groups still list, with an empty bar.
 */
export function ValueBreakdown({
  groups,
  formatters,
  emptyLabel,
}: {
  groups: readonly ValueGroup[];
  formatters: Formatters;
  emptyLabel: string;
}) {
  if (groups.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const max = Math.max(...groups.map((g) => g.value), 0);
  return (
    <ul className="flex flex-col gap-3" data-testid="value-breakdown">
      {groups.slice(0, 12).map((group) => {
        const fraction = max > 0 ? group.value / max : 0;
        const widthPercent = Math.max(2, Math.round(fraction * 100));
        return (
          <li key={group.id ?? 'ungrouped'} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{group.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatters.currency(group.value)}
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
      })}
    </ul>
  );
}
