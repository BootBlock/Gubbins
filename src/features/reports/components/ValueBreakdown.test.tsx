import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeFormatters } from '@/lib/format';
import type { ValueGroup } from '../reports';
import { ValueBreakdown, VALUE_BREAKDOWN_INITIAL_GROUPS } from './ValueBreakdown';

const formatters = makeFormatters('en-GB', 'GBP');

/** `count` groups, descending in value, as `sortValueGroups` would hand them over. */
function groups(count: number): ValueGroup[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `g${i}`,
    name: `Group ${i}`,
    quantity: 1,
    value: count - i,
  }));
}

function renderBreakdown(count: number) {
  return render(
    <ValueBreakdown
      groups={groups(count)}
      formatters={formatters}
      label="categories"
      emptyLabel="No priced stock yet."
    />,
  );
}

describe('ValueBreakdown', () => {
  it('says how many of how many groups are on screen rather than presenting a slice as the whole set (issue #609)', () => {
    renderBreakdown(40);
    expect(screen.getAllByRole('listitem')).toHaveLength(VALUE_BREAKDOWN_INITIAL_GROUPS);
    expect(screen.getByTestId('value-breakdown-more-summary')).toHaveTextContent(
      'Showing 12 of 40 categories',
    );
  });

  it('reveals the rest a step at a time, and collapses back', () => {
    renderBreakdown(40);
    fireEvent.click(screen.getByTestId('value-breakdown-more-more'));
    expect(screen.getAllByRole('listitem')).toHaveLength(24);
    expect(screen.getByTestId('value-breakdown-more-summary')).toHaveTextContent(
      'Showing 24 of 40 categories',
    );
    // The revealed rows are the next ones down the ordering, not a re-shuffle.
    expect(screen.getByText('Group 23')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('value-breakdown-more-less'));
    expect(screen.getAllByRole('listitem')).toHaveLength(VALUE_BREAKDOWN_INITIAL_GROUPS);
  });

  it('scales a revealed bar against the whole set, not against the rows on screen', () => {
    const { container } = renderBreakdown(40);
    fireEvent.click(screen.getByTestId('value-breakdown-more-more'));
    const bars = container.querySelectorAll<HTMLElement>('.bg-primary');
    // Group 0 holds 40 of the largest value; group 12 holds 28 ⇒ 70% of the leader, a share
    // that would read as 100% if the maximum were taken over the visible rows only.
    expect(bars[0]?.style.width).toBe('100%');
    expect(bars[12]?.style.width).toBe('70%');
  });

  it('shows no footer when every group is already listed', () => {
    renderBreakdown(5);
    expect(screen.queryByTestId('value-breakdown-more')).not.toBeInTheDocument();
  });

  it('falls back to the empty label with nothing to break down', () => {
    renderBreakdown(0);
    expect(screen.getByText('No priced stock yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('value-breakdown-more')).not.toBeInTheDocument();
  });
});
