import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeFormatters } from '@/lib/format';
import type { DeadStockLine } from '../reports';
import { DEAD_STOCK_INITIAL_ROWS, DeadStockList } from './DeadStockList';

const formatters = makeFormatters('en-GB', 'GBP');

function lines(count: number, overrides: Partial<DeadStockLine> = {}): DeadStockLine[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `i${i}`,
    name: `Item ${i}`,
    quantity: 2,
    idleDays: 200 - i,
    value: 10,
    thresholdDays: 90,
    ...overrides,
  }));
}

describe('DeadStockList', () => {
  it('says how much of the worklist is on screen rather than emptying out at the cap (issue #609)', () => {
    render(<DeadStockList lines={lines(50)} thresholdDays={90} formatters={formatters} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(DEAD_STOCK_INITIAL_ROWS);
    expect(screen.getByTestId('dead-stock-more-summary')).toHaveTextContent('Showing 20 of 50 idle items');
  });

  it('makes the rest of the worklist reachable', () => {
    render(<DeadStockList lines={lines(50)} thresholdDays={90} formatters={formatters} />);
    fireEvent.click(screen.getByTestId('dead-stock-more-more'));
    expect(screen.getAllByRole('listitem')).toHaveLength(40);
    fireEvent.click(screen.getByTestId('dead-stock-more-more'));
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.queryByTestId('dead-stock-more-more')).not.toBeInTheDocument();
    expect(screen.getByTestId('dead-stock-more-summary')).toHaveTextContent('Showing 50 of 50 idle items');
  });

  it('shows no footer when the whole worklist already fits', () => {
    render(<DeadStockList lines={lines(3)} thresholdDays={90} formatters={formatters} />);
    expect(screen.queryByTestId('dead-stock-more')).not.toBeInTheDocument();
  });

  it('names a line’s own threshold when a location overrode the panel’s (issue #92)', () => {
    render(
      <DeadStockList lines={lines(1, { thresholdDays: 365 })} thresholdDays={90} formatters={formatters} />,
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('(of 365d)');
  });
});
