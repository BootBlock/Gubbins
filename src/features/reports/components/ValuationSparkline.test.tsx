import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeFormatters } from '@/lib/format';
import type { ValuationTrendReport } from '../valuation-trend';
import { ValuationSparkline } from './ValuationSparkline';

const formatters = makeFormatters('en-GB', 'GBP');

/** Milliseconds in a day — marks are day-grained (midnight UTC), so tests place them on days. */
const DAY_MS = 86_400_000;

function report(overrides: Partial<ValuationTrendReport> = {}): ValuationTrendReport {
  return {
    windowStart: 0,
    windowEnd: 3,
    points: [
      { at: 0, value: 100 },
      { at: 1, value: 120 },
      { at: 2, value: 140 },
      { at: 3, value: 150 },
    ],
    startValue: 100,
    endValue: 150,
    changeValue: 50,
    revaluations: [],
    ...overrides,
  };
}

describe('ValuationSparkline', () => {
  it('reads out the start, current and net-change figures', () => {
    render(<ValuationSparkline report={report()} formatters={formatters} />);
    // The Money control splits value across spans, so match on the container's text content.
    const strip = screen.getByTestId('valuation-sparkline');
    expect(strip.textContent).toContain('£100.00');
    expect(strip.textContent).toContain('£150.00');
    expect(strip.textContent).toContain('£50.00');
  });

  it('draws no revaluation mark, and no summary, when none were recorded (issue #481)', () => {
    render(<ValuationSparkline report={report()} formatters={formatters} />);
    expect(screen.queryAllByTestId('valuation-revaluation-mark')).toHaveLength(0);
    expect(screen.queryByTestId('valuation-revaluation-summary')).toBeNull();
  });

  it('marks each revalued day and says so in text, since the strip itself is aria-hidden (issue #481)', () => {
    render(
      <ValuationSparkline
        report={report({
          windowStart: DAY_MS * 10,
          windowEnd: DAY_MS * 14,
          revaluations: [
            { at: DAY_MS * 11, count: 2 },
            { at: DAY_MS * 13, count: 1 },
          ],
        })}
        formatters={formatters}
      />,
    );
    // One tick per marked day, not per revaluation — the marks are aggregated to the day.
    const ticks = screen.getAllByTestId('valuation-revaluation-mark');
    expect(ticks).toHaveLength(2);
    // Positioned by instant across the window, on the same padded scale as the line: a quarter of
    // the way along lands at PAD + 0.25 × (100 − 2 × PAD) = 26.
    expect(ticks[0]?.getAttribute('x1')).toBe('26');
    expect(ticks[1]?.getAttribute('x1')).toBe('74');

    // The strip is decorative, so the count (3 revaluations, not 2 days) must read out in text.
    const summary = screen.getByTestId('valuation-revaluation-summary');
    expect(summary.textContent).toContain('3 manual revaluations are marked below the line');
    expect(summary.textContent).toContain('12 Jan 1970');
    expect(summary.textContent).toContain('14 Jan 1970');
  });

  it('puts a tick on the same horizontal scale as the line itself (issue #481)', () => {
    // The ticks and the polyline share one `xAt` mapping. Drive both and compare rather than
    // restating the formula: a mark placed on a sample's instant must land on that sample's own x.
    // Probing both ends *and* both interior samples is what makes this catch a mapping that
    // diverges only in the middle — a wrong span denominator still agrees at 0 and 1.
    const start = DAY_MS * 10;
    render(
      <ValuationSparkline
        report={report({
          windowStart: start,
          windowEnd: start + 3 * DAY_MS,
          // The fixture's four points are evenly spaced, so sample i sits at start + i × DAY_MS.
          revaluations: [0, 1, 2, 3].map((i) => ({ at: start + i * DAY_MS, count: 1 })),
        })}
        formatters={formatters}
      />,
    );
    const polyline = screen
      .getByTestId('valuation-sparkline')
      .querySelector('polyline')!
      .getAttribute('points')!
      .split(' ');
    const lineXs = polyline.map((point) => point.split(',')[0]);
    const tickXs = screen.getAllByTestId('valuation-revaluation-mark').map((tick) => tick.getAttribute('x1'));

    expect(tickXs).toEqual(lineXs);
  });

  it('says an unmarked day is not a day nothing changed (issue #481)', () => {
    render(
      <ValuationSparkline report={report({ revaluations: [{ at: 1, count: 1 }] })} formatters={formatters} />,
    );
    // A `unit_cost` edit is not logged as a dated point, so it can never be marked. Without this
    // the absence of a tick reads as "nothing changed here", which the data cannot support.
    expect(screen.getByTestId('valuation-revaluation-summary').textContent).toContain(
      'a day without a mark is not a day nothing changed',
    );
  });

  it('captions what the trend promises — a shape indicator, not a per-day headline (issue #399)', () => {
    render(<ValuationSparkline report={report()} formatters={formatters} />);
    // The caption must make the "how today's holdings moved" promise explicit so the line is
    // never mistaken for the total the headline actually read on each past day.
    expect(screen.getByText(/how the value of today’s stock has moved/i)).toBeTruthy();
    expect(screen.getByText(/current items at their current prices/i)).toBeTruthy();
  });
});
