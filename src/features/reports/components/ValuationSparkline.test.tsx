import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeFormatters } from '@/lib/format';
import type { ValuationTrendReport } from '../valuation-trend';
import { ValuationSparkline } from './ValuationSparkline';

const formatters = makeFormatters('en-GB', 'GBP');

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

  it('captions what the trend promises — a shape indicator, not a per-day headline (issue #399)', () => {
    render(<ValuationSparkline report={report()} formatters={formatters} />);
    // The caption must make the "how today's holdings moved" promise explicit so the line is
    // never mistaken for the total the headline actually read on each past day.
    expect(screen.getByText(/how the value of today’s stock has moved/i)).toBeTruthy();
    expect(screen.getByText(/current items at their current prices/i)).toBeTruthy();
  });
});
