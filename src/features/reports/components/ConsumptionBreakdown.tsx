import { useT, type TypedTranslator } from '@/features/i18n';
import type { Formatters } from '@/lib/format';
import type { ConsumptionRateReport } from '../reports';

/**
 * A consumed amount rendered **in its own unit**: `400g` through the shared `measure` formatter —
 * the same seam every gauge surface prints a net value with, so a consumption figure reads exactly
 * as the gauge it came from does — or, for the unitless line, a plain count of units.
 *
 * Exported because the Reports screen's headline tile shows the leading line and must print it
 * identically to the panel below; one function is what keeps the two from drifting.
 */
export function formatConsumed(
  amount: number,
  unit: string | null,
  formatters: Formatters,
  t: TypedTranslator,
): string {
  if (unit !== null) return formatters.measure(amount, unit);
  // `quantity` carries no unit of its own, so the noun comes from the catalog rather than a
  // concatenation here; it is rounded to match what `measure` does with a fractional value.
  return t('reports.consumption.unitlessAmount', {
    vars: { amount: formatters.quantity(Math.round(amount * 100) / 100) },
  });
}

/**
 * The consumption rate, one row per **unit of measure** (issue #685).
 *
 * The report used to be a single number that added every negative stock movement together —
 * grams, millilitres, metres and screws — and divided it by the window. Since `unit_of_measure`
 * is free text with no conversion layer, the only honest presentation is one figure per unit,
 * each labelled, and no total across them.
 *
 * Deliberately **not** a bar breakdown like `ValueBreakdown`: a bar's length invites
 * comparison between rows, which is exactly the comparison that has no meaning here (400 g is
 * neither more nor less than 6 screws). Plain labelled figures say only what is true.
 */
export function ConsumptionBreakdown({
  report,
  formatters,
  emptyLabel,
}: {
  report: ConsumptionRateReport;
  formatters: Formatters;
  emptyLabel: string;
}) {
  const t = useT();
  if (report.lines.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-border" data-testid="consumption-breakdown">
        {report.lines.map((line) => (
          <li key={line.unit ?? ''} className="flex items-baseline justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate font-medium">
              {line.unit ?? t('reports.consumption.unitless')}
            </span>
            <span className="flex shrink-0 items-baseline gap-4 text-muted-foreground">
              <span>
                {t('reports.consumption.total', {
                  vars: { amount: formatConsumed(line.totalConsumed, line.unit, formatters, t) },
                })}
              </span>
              <span className="font-medium text-foreground">
                {t('reports.consumption.rate', {
                  vars: { amount: formatConsumed(line.perDay, line.unit, formatters, t) },
                })}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('reports.consumption.note')}</p>
    </div>
  );
}
