/**
 * The Activity Log's before/after value list (issue #486).
 *
 * The pure formatting is driven in `history-change-format.test.ts`; what is left to prove here is
 * that the row actually puts both values on screen, labels them, and reads as a *change* rather
 * than as two unrelated figures to someone using a screen reader.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { HistoryFieldChange } from '../history-format';

vi.mock('../categories', () => ({
  useCategoryNames: () => new Map([['cat-1', 'Power tools']]),
}));

const { HistoryChangeList } = await import('./HistoryChangeList');

function renderChanges(changes: readonly HistoryFieldChange[]) {
  render(<HistoryChangeList changes={changes} />);
  return screen.getByTestId('activity-log-changes');
}

describe('HistoryChangeList', () => {
  it('shows each changed field with the value before and the value after', () => {
    const list = renderChanges([
      { field: 'unitCost', from: 4, to: 5.5 },
      { field: 'barcode', from: null, to: '5012345678900' },
    ]);

    expect(within(list).getByText('Unit cost')).toBeInTheDocument();
    // Asserted without the currency symbol, which follows the user's preference: what matters is
    // that a price renders as a price (two decimals, through `Money`) rather than as a bare `4`.
    expect(list.textContent).toMatch(/4\.00/);
    expect(list.textContent).toMatch(/5\.50/);

    expect(within(list).getByText('Barcode')).toBeInTheDocument();
    // A cleared/unset value reads as words, never as a blank cell.
    expect(within(list).getByText('Not set')).toBeInTheDocument();
    expect(within(list).getByText('5012345678900')).toBeInTheDocument();
  });

  it('resolves a category id to its name', () => {
    const list = renderChanges([{ field: 'categoryId', from: null, to: 'cat-1' }]);
    expect(within(list).getByText('Power tools')).toBeInTheDocument();
  });

  it('spells the relation out for assistive tech, and hides the decorative arrow', () => {
    // Without this a screen reader reads "Unit cost £4.00 £5.50" — two figures with no relation.
    const list = renderChanges([{ field: 'unitCost', from: 4, to: 5.5 }]);
    expect(within(list).getByText('changed to')).toBeInTheDocument();
    expect(list.querySelector('[aria-hidden="true"]')?.textContent).toBe('→');
  });

  it('shows a field this build does not know rather than dropping it from the trail', () => {
    const list = renderChanges([{ field: 'someFutureField', from: 'a', to: 'b' }]);
    expect(within(list).getByText('someFutureField')).toBeInTheDocument();
    expect(within(list).getByText('a')).toBeInTheDocument();
    expect(within(list).getByText('b')).toBeInTheDocument();
  });
});
