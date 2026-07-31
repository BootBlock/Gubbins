import type { TypedTranslator } from '@/features/i18n';
import type { Formatters } from '@/lib/format';

/**
 * A consumed amount rendered **in its own unit**: `400g` through the shared `measure` formatter —
 * the same seam every gauge surface prints a net value with, so a consumption figure reads exactly
 * as the gauge it came from does — or, for the unitless line, a plain count of units.
 *
 * Its own module rather than a second export from `ConsumptionBreakdown`: the Reports screen's
 * headline tile shows the leading line and must print it identically to the panel below, so both
 * call this, and a component file that also exports a plain function breaks Fast Refresh.
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
