import { Money, ShowMore, useProgressiveReveal } from '@/components/foundry';
import { useT } from '@/features/i18n';
import type { Formatters } from '@/lib/format';
import type { TurnoverReport } from '../turnover';

/** How many item rows the table opens with, and how many each "show more" adds. */
export const TURNOVER_INITIAL_ROWS = 12;

/**
 * Format a turnover ratio as `2.4×` (one decimal place), or an em dash when there is no value to
 * turn over. A plain decimal — not `toLocaleString` — so the ratio never gains locale thousands
 * grouping the surrounding figures don't use.
 */
function formatRatio(value: number | null): string {
  return value == null ? '—' : `${Math.round(value * 10) / 10}×`;
}

/** Format a days-on-hand figure as a rounded day count, or an em dash when undefined. */
function formatDays(value: number | null, formatters: Formatters): string {
  return value == null ? '—' : `${formatters.quantity(Math.round(value))} days`;
}

/**
 * A token-styled inventory-turnover panel: the portfolio headline (turnover ratio + days of
 * cover) over a per-item table sorted fastest-movers-first. Pure presentation — all maths is in
 * the `summariseTurnover` seam — composed with Tailwind + tokens only (no chart dependency).
 *
 * The table opens on the leading {@link TURNOVER_INITIAL_ROWS} items, but never presents them as
 * the whole set (issue #609): the `ShowMore` footer counts what is held back and reveals it a
 * chunk at a time. The headline figures above are portfolio-wide either way — they are summed
 * over every line, not over the rows on screen.
 */
export function TurnoverTable({ report, formatters }: { report: TurnoverReport; formatters: Formatters }) {
  const t = useT();
  const reveal = useProgressiveReveal(report.lines.length, { initial: TURNOVER_INITIAL_ROWS });

  if (report.lines.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No stock to analyse yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="turnover-table">
      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Portfolio turnover
          </span>
          <span
            className="text-2xl font-semibold tracking-tight tabular-nums"
            data-testid="turnover-headline"
          >
            {formatRatio(report.turnover)}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Days of cover
          </span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatDays(report.daysOnHand, formatters)}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Item</th>
              <th className="py-1.5 px-3 text-right font-medium">Turnover</th>
              <th className="py-1.5 px-3 text-right font-medium">Consumed</th>
              <th className="py-1.5 pl-3 text-right font-medium">Days</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {report.lines.slice(0, reveal.limit).map((line) => (
              <tr key={line.id}>
                <td className="w-full max-w-0 truncate py-1.5 pr-3 font-medium">{line.name}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{formatRatio(line.turnover)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">
                  <Money value={line.cogs} formatters={formatters} />
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-muted-foreground">
                  {formatDays(line.daysOnHand, formatters)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ShowMore
        shown={reveal.limit}
        total={report.lines.length}
        label={t('common.rows.items')}
        expanded={reveal.expanded}
        onShowMore={reveal.showMore}
        onShowLess={reveal.showLess}
        data-testid="turnover-more"
      />
    </div>
  );
}
