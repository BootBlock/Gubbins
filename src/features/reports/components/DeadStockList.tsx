import { Money, ShowMore, useProgressiveReveal } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { Formatters } from '@/lib/format';
import type { DeadStockLine } from '../reports';

/** How many idle items the list opens with, and how many each "show more" adds. */
export const DEAD_STOCK_INITIAL_ROWS = 20;

/**
 * The Reports screen's dead-stock lines — the items that have sat unmoved past their threshold,
 * most idle first, with the capital each is holding.
 *
 * This is a worklist rather than a summary, so it must never look shorter than it is (issue #609):
 * a capped list with nothing beneath it lets a user work through it, watch it empty and believe
 * the job is done. The `ShowMore` footer states how many of how many are on screen and makes the
 * rest reachable — in chunks, because the list is unvirtualised and an inventory can put thousands
 * of items in it.
 */
export function DeadStockList({
  lines,
  thresholdDays,
  formatters,
}: {
  lines: readonly DeadStockLine[];
  /** The global idle threshold the panel is titled with — a line naming another says so. */
  thresholdDays: number;
  formatters: Formatters;
}) {
  const t = useT();
  const reveal = useProgressiveReveal(lines.length, { initial: DEAD_STOCK_INITIAL_ROWS });

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border" data-testid="dead-stock-list">
        {lines.slice(0, reveal.limit).map((line) => (
          <li key={line.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate font-medium">{line.name}</span>
            <span className="flex shrink-0 items-center gap-4 text-muted-foreground">
              {/* A gauge is idle by its *contents*, not a unit count it does not have
                  (issue #683) — "400g", not "0 units". */}
              <span>
                {line.measure
                  ? formatters.measure(line.measure.amount, line.measure.unit)
                  : `${formatters.quantity(line.quantity)} units`}
              </span>
              {/* A location may set its own threshold, so a line can be flagged at a
                  figure other than the one in the panel heading — show it rather
                  than leave the row looking wrong. */}
              <span>
                {line.idleDays}d idle
                {line.thresholdDays !== thresholdDays ? ` (of ${line.thresholdDays}d)` : ''}
              </span>
              <Money value={line.value} formatters={formatters} className="font-medium text-foreground" />
            </span>
          </li>
        ))}
      </ul>
      {/* The noun is "idle items", not the turnover table's plain "items": both panels sit on the
          Reports screen at once, and two controls named "Show more: items" would be
          indistinguishable to a screen reader. */}
      <ShowMore
        shown={reveal.limit}
        total={lines.length}
        label={t('common.rows.idleItems')}
        expanded={reveal.expanded}
        onShowMore={reveal.showMore}
        onShowLess={reveal.showLess}
        data-testid="dead-stock-more"
      />
    </div>
  );
}
