import { Money } from '@/components/foundry';
import { useT, type TypedTranslator } from '@/features/i18n';
import type { Formatters } from '@/lib/format';
import type { RevaluationMark, ValuationTrendReport } from '../valuation-trend';

/** SVG viewBox dimensions — a wide, short sparkline strip. Stroke-only, so units are arbitrary. */
const VIEW_W = 100;
const VIEW_H = 32;
const PAD = 2;

/** How tall a revaluation tick stands from the bottom edge of the strip, in viewBox units. */
const TICK_H = 6;

/** How many marked dates the summary spells out before the rest collapse into an "and N more". */
const LISTED_DATES = 4;

/**
 * A hand-rolled SVG sparkline of the reconstructed inventory-value trend (no chart dependency,
 * §2.4.3) — a single polyline over the `primary` token, with the start/end values and the net
 * change (tinted by sign with the `success`/`destructive` tokens) read in text beside it. The
 * line is decorative (`aria-hidden`); the textual figures carry the accessible summary.
 *
 * The caption states plainly what the line promises (issue #399). The trend is anchored to the
 * "Inventory value" headline and reconstructed backward by re-pricing each past movement at the
 * item's value **as it stands today** — so it shows how *today's* holdings have moved in shape,
 * not the figure the headline actually read on each past day. A mid-window revaluation therefore
 * does not appear as a step; the caption keeps that honest rather than letting the line imply an
 * audited history it does not carry.
 *
 * **Revaluation marks (issue #481).** What the caption could only describe, the ticks along the
 * bottom edge now point at: each one stands on a day a value was manually reset. They are
 * annotation, not data — no point on the line moves, so the promise above and the headline anchor
 * are both untouched. They are drawn inside the `aria-hidden` strip, so the sentence beneath
 * carries the same information in text, including the caveat that a `unit_cost` edit is not
 * logged as a dated point and so cannot be marked at all. An absent mark means "nothing was
 * *recorded* here", never "nothing changed here".
 */
export function ValuationSparkline({
  report,
  formatters,
}: {
  report: ValuationTrendReport;
  formatters: Formatters;
}) {
  const t = useT();
  const values = report.points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  const n = report.points.length;

  // Map each point into the padded viewBox. A flat line (range 0) sits on the vertical centre.
  const coords = report.points.map((p, i) => {
    const x = n > 1 ? xAt(i / (n - 1)) : VIEW_W / 2;
    const y = range > 0 ? VIEW_H - PAD - ((p.value - min) / range) * (VIEW_H - 2 * PAD) : VIEW_H / 2;
    return `${round2(x)},${round2(y)}`;
  });

  const rising = report.changeValue >= 0;
  const marks = report.revaluations;
  const markedRevaluations = marks.reduce((sum, mark) => sum + mark.count, 0);

  return (
    <div className="flex flex-col gap-3" data-testid="valuation-sparkline">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        aria-hidden="true"
      >
        <polyline
          points={coords.join(' ')}
          fill="none"
          className="stroke-primary"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {marks.map((mark) => {
          const x = markX(mark, report.windowStart, report.windowEnd);
          return (
            <line
              key={mark.at}
              x1={x}
              x2={x}
              y1={VIEW_H - PAD - TICK_H}
              y2={VIEW_H - PAD}
              className="stroke-muted-foreground"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              data-testid="valuation-revaluation-mark"
            >
              {/* A hover tooltip for pointer users; the sentence below is what carries it in text. */}
              <title>
                {t('reports.valuationTrend.revaluationMark', {
                  vars: { count: mark.count, date: formatters.calendarDate(mark.at) },
                })}
              </title>
            </line>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span className="text-muted-foreground">
          Start{' '}
          <Money value={report.startValue} formatters={formatters} className="font-medium text-foreground" />
        </span>
        <span className="text-muted-foreground">
          Now{' '}
          <Money value={report.endValue} formatters={formatters} className="font-medium text-foreground" />
        </span>
        <span className={`font-medium tabular-nums ${rising ? 'text-success' : 'text-destructive'}`}>
          {rising ? '+' : '−'}
          <Money value={Math.abs(report.changeValue)} formatters={formatters} />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Shows how the value of today&rsquo;s stock has moved. Earlier points value your current items at their
        current prices, so this reflects the trend&rsquo;s shape rather than the total the headline showed on
        each past day.
      </p>
      {markedRevaluations > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="valuation-revaluation-summary">
          {t('reports.valuationTrend.revaluations', {
            vars: { count: markedRevaluations, dates: markedDates(marks, formatters, t) },
          })}{' '}
          {t('reports.valuationTrend.revaluationsNote')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The only horizontal scale in this component: `0..1` across the window → an x inside the padded
 * viewBox. Both the polyline (by point index) and the revaluation ticks (by instant) go through
 * it, so a tick cannot drift off the line's scale — there is one mapping, not two that have to be
 * kept in step.
 */
function xAt(fraction: number): number {
  return PAD + fraction * (VIEW_W - 2 * PAD);
}

/** Two decimal places — plenty for a 100-unit-wide viewBox, and it keeps the markup readable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The horizontal position of a mark, interpolated from the mark's instant rather than from a point
 * index, so a tick sits where the day fell rather than on the nearest sample.
 *
 * The fraction is **clamped to `0..1`**: a mark is floored to midnight UTC, so a revaluation
 * recorded late on the window's first day (one written from the wall clock rather than the
 * day-grained editor) can floor to an instant just before `windowStart` and would otherwise be
 * drawn outside the strip. A degenerate window (`windowEnd <= windowStart`) centres the tick.
 */
function markX(mark: RevaluationMark, windowStart: number, windowEnd: number): number {
  const span = windowEnd - windowStart;
  if (!(span > 0)) return VIEW_W / 2;
  return round2(xAt(Math.min(1, Math.max(0, (mark.at - windowStart) / span))));
}

/**
 * The marked days as a readable list, capped at {@link LISTED_DATES} so a heavily-revalued window
 * ends in "+N more" rather than a paragraph of dates. Day-grained instants are rendered with
 * `calendarDate` (not `date`), which is what keeps a midnight-UTC value on the same calendar day
 * west of UTC.
 */
function markedDates(marks: readonly RevaluationMark[], formatters: Formatters, t: TypedTranslator): string {
  const shown = marks.slice(0, LISTED_DATES).map((mark) => formatters.calendarDate(mark.at));
  const remaining = marks.length - shown.length;
  if (remaining > 0) {
    shown.push(t('reports.valuationTrend.revaluationsMore', { vars: { count: remaining } }));
  }
  return shown.join(', ');
}
