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

  it('scales the bars against the whole set, not against the rows on screen', () => {
    // `sortValueGroups` forces the ungrouped bucket last **regardless of its value**, so the
    // largest group can sit off the opening slice — the case where "max over all" and "max over
    // visible" actually differ, and the one a strictly-descending fixture would never reach.
    const { container } = render(
      <ValueBreakdown
        groups={[...groups(14), { id: null, name: 'Ungrouped', quantity: 1, value: 100 }]}
        formatters={formatters}
        label="categories"
        emptyLabel="No priced stock yet."
      />,
    );
    const bars = container.querySelectorAll<HTMLElement>('.bg-primary');
    // The leading visible group holds 14 against the off-screen maximum of 100 ⇒ 14%. Scaled
    // against the visible rows alone it would read 100%.
    expect(bars[0]?.style.width).toBe('14%');
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
