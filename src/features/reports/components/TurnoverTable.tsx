import type { Formatters } from '@/lib/format';
import type { TurnoverReport } from '../turnover';

/** Format a turnover ratio as `2.4×`, or an em dash when there is no value to turn over. */
function formatRatio(value: number | null): string {
  return value == null ? '—' : `${(Math.round(value * 10) / 10).toLocaleString()}×`;
}

/** Format a days-on-hand figure as a rounded day count, or an em dash when undefined. */
function formatDays(value: number | null, formatters: Formatters): string {
  return value == null ? '—' : `${formatters.quantity(Math.round(value))} days`;
}

/**
 * A token-styled inventory-turnover panel: the portfolio headline (turnover ratio + days of
 * cover) over a per-item table sorted fastest-movers-first. Pure presentation — all maths is in
 * the `summariseTurnover` seam — composed with Tailwind + tokens only (no chart dependency).
 */
export function TurnoverTable({
  report,
  formatters,
}: {
  report: TurnoverReport;
  formatters: Formatters;
}) {
  if (report.lines.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">No stock to analyse yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="turnover-table">
      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Portfolio turnover
          </span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums" data-testid="turnover-headline">
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
            {report.lines.slice(0, 12).map((line) => (
              <tr key={line.id}>
                <td className="max-w-0 truncate py-1.5 pr-3 font-medium">{line.name}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{formatRatio(line.turnover)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">
                  {formatters.currency(line.cogs)}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-muted-foreground">
                  {formatDays(line.daysOnHand, formatters)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
