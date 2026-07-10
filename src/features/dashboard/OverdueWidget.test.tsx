import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { CheckoutWithNames } from '@/db/repositories';
import { MS_PER_DAY } from '@/db/repositories/constants';
import { widgetById } from './widgets';

/**
 * The Overdue widget surfaces a late loan as prominently as low stock surfaces its shortfall:
 * an at-a-glance "N days overdue" affordance, a danger tone reserved for genuinely-late loans,
 * and a quiet footer acknowledging loans still out but not yet due. The single open-checkouts
 * feed is mocked so this exercises only the widget's rendering of that escalation.
 */
const spies = vi.hoisted(() => ({ openCheckouts: vi.fn() }));

vi.mock('@/features/contacts/contacts', () => ({
  useOpenCheckouts: () => spies.openCheckouts(),
}));

const NOW = Date.now();

const baseCheckout: CheckoutWithNames = {
  id: 'k1',
  itemId: 'i1',
  borrowerType: 'contact',
  contactId: 'c1',
  projectId: null,
  locationId: null,
  quantity: 1,
  dueDate: null,
  note: null,
  checkedOutAt: NOW - 10 * MS_PER_DAY,
  returnedAt: null,
  sourceLocationId: null,
  sourceBatchKey: null,
  updatedAt: NOW,
  itemName: 'Item',
  borrowerName: 'Contact',
  status: 'OPEN',
  isOverdue: false,
};

/** A loan, defaulting to open + not overdue; overrides set the overdue/due-date shape. */
const loan = (over: Partial<CheckoutWithNames> = {}): CheckoutWithNames => ({ ...baseCheckout, ...over });

const OverdueWidget = widgetById('overdue')!.Component;

function mockOpen(rows: CheckoutWithNames[]) {
  spies.openCheckouts.mockReturnValue({ data: { rows }, isPending: false, isError: false });
}

beforeEach(() => {
  spies.openCheckouts.mockReturnValue({ data: { rows: [] }, isPending: false, isError: false });
});

afterEach(() => {
  cleanup();
  spies.openCheckouts.mockReset();
});

describe('OverdueWidget — days-overdue affordance', () => {
  it('spells out how many days overdue a late loan is, alongside the contact', () => {
    mockOpen([
      loan({
        id: 'a',
        itemName: 'Camera',
        borrowerName: 'Sam',
        dueDate: NOW - 3 * MS_PER_DAY,
        isOverdue: true,
      }),
    ]);

    render(<OverdueWidget />);
    const row = screen.getByText('Camera').closest('div');
    expect(within(row!).getByText(/with Sam/)).toBeInTheDocument();
    expect(within(row!).getByTestId('overdue-days')).toHaveTextContent('3 days overdue');
  });

  it('reads a plain "Overdue" for a loan late by less than a full day', () => {
    mockOpen([loan({ id: 'a', itemName: 'Tripod', dueDate: NOW - 60 * 60 * 1000, isOverdue: true })]);

    render(<OverdueWidget />);
    expect(screen.getByTestId('overdue-days')).toHaveTextContent('Overdue');
    expect(screen.getByTestId('overdue-days')).not.toHaveTextContent('day');
  });

  it('shows a quiet footer for loans still out but not yet due (escalation legible)', () => {
    mockOpen([
      loan({ id: 'a', itemName: 'Late', dueDate: NOW - 2 * MS_PER_DAY, isOverdue: true }),
      loan({ id: 'b', itemName: 'Soon', dueDate: NOW + 2 * MS_PER_DAY, isOverdue: false }),
      loan({ id: 'c', itemName: 'Open', dueDate: null, isOverdue: false }),
    ]);

    render(<OverdueWidget />);
    // Only the late loan is listed; the two still-open loans surface as the quiet footer.
    expect(screen.getByText('Late')).toBeInTheDocument();
    expect(screen.queryByText('Soon')).toBeNull();
    expect(screen.getByText('2 more on loan, not yet due.')).toBeInTheDocument();
  });

  it('stays quiet when loans are open but none are overdue', () => {
    mockOpen([
      loan({ id: 'a', itemName: 'Soon', dueDate: NOW + MS_PER_DAY, isOverdue: false }),
      loan({ id: 'b', itemName: 'Open', dueDate: null, isOverdue: false }),
    ]);

    render(<OverdueWidget />);
    expect(screen.queryByTestId('overdue-days')).toBeNull();
    expect(screen.getByText('Nothing overdue — 2 on loan.')).toBeInTheDocument();
  });

  it('reads all-clear when there are no open loans at all', () => {
    mockOpen([]);
    render(<OverdueWidget />);
    expect(screen.getByText('Nothing overdue.')).toBeInTheDocument();
  });
});
