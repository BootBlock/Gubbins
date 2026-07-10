import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CheckoutWithNames } from '@/db/repositories';

/**
 * Pins the {@link BorrowerLoansSection} contract (B4): it lists the loans still out to a
 * project/location via the shared LoanRow (showing the polymorphic `borrowerName`) and opens
 * the Return / Renew dialogs on click. The two dialogs are stubbed — their own behaviour is
 * covered by their own tests; here we only assert this panel wires them up.
 */

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ date: (ms: number) => `date:${ms}` }),
}));
vi.mock('./CheckInDialog', () => ({
  CheckInDialog: ({ checkout }: { checkout: CheckoutWithNames }) => (
    <div data-testid="checkin-dialog">returning {checkout.itemName}</div>
  ),
}));
vi.mock('./RenewLoanDialog', () => ({
  RenewLoanDialog: ({ checkout }: { checkout: CheckoutWithNames }) => (
    <div data-testid="renew-dialog">renewing {checkout.itemName}</div>
  ),
}));

import { BorrowerLoansSection } from './BorrowerLoansSection';

const loan = (overrides: Partial<CheckoutWithNames> = {}): CheckoutWithNames => ({
  id: 'k1',
  itemId: 'i1',
  borrowerType: 'project',
  contactId: null,
  projectId: 'p1',
  locationId: null,
  quantity: 2,
  dueDate: null,
  checkedOutAt: 0,
  returnedAt: null,
  note: null,
  returnNote: null,
  sourceLocationId: null,
  sourceBatchKey: null,
  updatedAt: 0,
  itemName: 'Impact driver',
  borrowerName: 'Henderson job',
  status: 'OPEN',
  isOverdue: false,
  ...overrides,
});

afterEach(cleanup);

describe('BorrowerLoansSection (B4)', () => {
  it('renders each open loan with its item and borrower name', () => {
    render(<BorrowerLoansSection loans={[loan()]} emptyText="Nothing out." />);
    expect(screen.getByText('Impact driver')).toBeTruthy();
    expect(screen.getByText('Henderson job')).toBeTruthy();
  });

  it('shows the empty text when nothing is out', () => {
    render(<BorrowerLoansSection loans={[]} emptyText="Nothing out on this project." />);
    expect(screen.getByText('Nothing out on this project.')).toBeTruthy();
  });

  it('filters out already-returned loans', () => {
    render(
      <BorrowerLoansSection
        loans={[loan({ id: 'done', status: 'RETURNED', returnedAt: 1 })]}
        emptyText="Nothing out."
      />,
    );
    expect(screen.getByText('Nothing out.')).toBeTruthy();
    expect(screen.queryByText('Impact driver')).toBeNull();
  });

  it('opens the return dialog when Return is clicked', () => {
    render(<BorrowerLoansSection loans={[loan()]} emptyText="Nothing out." />);
    expect(screen.queryByTestId('checkin-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Return/ }));
    expect(screen.getByTestId('checkin-dialog')).toHaveTextContent('returning Impact driver');
  });

  it('opens the renew dialog when Renew is clicked', () => {
    render(<BorrowerLoansSection loans={[loan()]} emptyText="Nothing out." />);
    fireEvent.click(screen.getByRole('button', { name: /Renew/ }));
    expect(screen.getByTestId('renew-dialog')).toHaveTextContent('renewing Impact driver');
  });
});
