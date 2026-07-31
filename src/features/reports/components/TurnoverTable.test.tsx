import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeFormatters } from '@/lib/format';
import type { TurnoverReport } from '../turnover';
import { TURNOVER_INITIAL_ROWS, TurnoverTable } from './TurnoverTable';

const formatters = makeFormatters('en-GB', 'GBP');

function report(lineCount: number): TurnoverReport {
  return {
    windowDays: 30,
    lines: Array.from({ length: lineCount }, (_, i) => ({
      id: `i${i}`,
      name: `Item ${i}`,
      cogs: 100,
      avgValue: 50,
      turnover: 2,
      daysOnHand: 15,
    })),
    totalCogs: 100 * lineCount,
    totalAvgValue: 50 * lineCount,
    turnover: 2,
    daysOnHand: 15,
  };
}

describe('TurnoverTable', () => {
  it('says how many of how many items the table is showing (issue #609)', () => {
    render(<TurnoverTable report={report(30)} formatters={formatters} />);
    // One row per item, plus the heading row.
    expect(screen.getAllByRole('row')).toHaveLength(TURNOVER_INITIAL_ROWS + 1);
    expect(screen.getByTestId('turnover-more-summary')).toHaveTextContent('Showing 12 of 30 items');
  });

  it('reveals the slower movers on request', () => {
    render(<TurnoverTable report={report(30)} formatters={formatters} />);
    fireEvent.click(screen.getByTestId('turnover-more-more'));
    expect(screen.getAllByRole('row')).toHaveLength(25);
    expect(screen.getByText('Item 23')).toBeInTheDocument();
  });

  it('shows no footer when every item already has a row', () => {
    render(<TurnoverTable report={report(4)} formatters={formatters} />);
    expect(screen.queryByTestId('turnover-more')).not.toBeInTheDocument();
  });
});
