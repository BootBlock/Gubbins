/**
 * Component tests for the Wishlist tab (feature-gap G8). Mocked at the query boundary so no DB or
 * QueryClient is needed — the point is the affordance: the list renders entries (priority badge,
 * sanitised link, target price), the empty state shows, "Add wish" opens the create dialog and a
 * submit calls the create mutation, and a row's delete calls the delete mutation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { WishlistEntry } from '@/db/repositories';

let rows: WishlistEntry[];
/** Whether the read-everything walk hit its safety ceiling (issue #149). */
let truncated: boolean;
let createSpy: ReturnType<typeof vi.fn>;
let deleteSpy: ReturnType<typeof vi.fn>;

vi.mock('./wishlist-queries', () => ({
  useWishlist: () => ({ isLoading: false, data: { rows, truncated } }),
  useCreateWishlistEntry: () => ({ mutate: createSpy, isPending: false, isSuccess: false }),
  useUpdateWishlistEntry: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteWishlistEntry: () => ({ mutate: deleteSpy, isPending: false, isSuccess: false }),
}));

// The import dialog is mounted (closed) by the tab, so its mutation hooks run on every render.
vi.mock('./purchase-list-queries', () => ({
  useImportPurchaseListIntoOrder: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateOrderFromPurchaseList: () => ({ mutate: vi.fn(), isPending: false }),
  useImportPurchaseListIntoWishlist: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    currencyParts: (v: number) => [
      { type: 'currency', value: '£' },
      { type: 'literal', value: v.toFixed(2) },
    ],
    quantity: (v: number) => String(v),
    date: () => '',
    dateTime: () => '',
    relativeTime: () => '',
    percent: () => '',
  }),
}));

// Imported after the mocks are registered.
import { WishlistTab } from './WishlistTab';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

const entry = (over: Partial<WishlistEntry>): WishlistEntry => ({
  id: 'w1',
  name: 'Impact driver',
  note: null,
  url: null,
  targetPrice: null,
  priority: 'NONE',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('WishlistTab (feature-gap G8)', () => {
  beforeEach(() => {
    rows = [];
    truncated = false;
    createSpy = vi.fn();
    deleteSpy = vi.fn();
  });

  afterEach(cleanup);

  it('shows the empty state when the wishlist has no entries', () => {
    render(<WishlistTab />);
    expect(screen.getByTestId('wishlist-empty')).toBeInTheDocument();
    expect(screen.getByTestId('wishlist-count-live')).toHaveTextContent('Your wishlist is empty.');
  });

  it('renders an entry with its priority badge, link and target price', () => {
    rows = [
      entry({
        name: 'Impact driver',
        priority: 'HIGH',
        url: 'https://example.test/driver',
        targetPrice: 180,
      }),
    ];
    render(<WishlistTab />);

    expect(screen.getByText('Impact driver')).toBeInTheDocument();
    expect(screen.getByTestId('wishlist-priority-badge')).toHaveTextContent('High');
    expect(screen.getByTestId('wishlist-link')).toHaveAttribute('href', 'https://example.test/driver');
    expect(screen.getByTestId('wishlist-link')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('wishlist-target-price-value')).toHaveTextContent('£180.00');
    // A summary line reflects the single priced item.
    expect(screen.getByTestId('wishlist-summary')).toHaveTextContent('est.');
  });

  it('opens the add dialog and creates an entry on submit', () => {
    render(<WishlistTab />);
    fireEvent.click(screen.getByTestId('wishlist-add'));
    expect(screen.getByTestId('wishlist-form')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('wishlist-name'), { target: { value: 'Spare filters' } });
    fireEvent.click(screen.getByTestId('wishlist-save'));

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toMatchObject({ name: 'Spare filters' });
  });

  it('blocks submit and shows a field error when the name is blank', () => {
    render(<WishlistTab />);
    fireEvent.click(screen.getByTestId('wishlist-add'));
    fireEvent.click(screen.getByTestId('wishlist-save'));

    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByText('A name is required.')).toBeInTheDocument();
  });

  /**
   * A wish is typed by hand and hard-deleted with no undo, so the row's bin asks before it
   * removes anything (issue #588) rather than deleting on the click that opened it.
   */
  it('asks before deleting an entry, and does not delete until confirmed', () => {
    rows = [entry({ id: 'w-del', name: 'Old thing' })];
    render(<WishlistTab />);

    fireEvent.click(screen.getByTestId('wishlist-delete'));
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toContain('Old thing');

    fireEvent.click(screen.getByTestId('wishlist-delete-confirm'));
    expect(deleteSpy).toHaveBeenCalledWith('w-del', expect.anything());
  });

  it('leaves the entry alone when the confirmation is dismissed', () => {
    rows = [entry({ id: 'w-del', name: 'Old thing' })];
    render(<WishlistTab />);

    fireEvent.click(screen.getByTestId('wishlist-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('WishlistTab — a wishlist longer than one read (issue #149)', () => {
  beforeEach(() => {
    rows = [];
    truncated = false;
    createSpy = vi.fn();
    deleteSpy = vi.fn();
  });

  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
  });

  /** 140 wishes — more than one capped repository read would return. */
  const manyWishes = () =>
    Array.from({ length: 140 }, (_, i) =>
      entry({ id: `w${i}`, name: `Wish ${String(i + 1).padStart(3, '0')}`, targetPrice: 1 }),
    );

  it('shows every wish and totals all of them, not just the first read', () => {
    rows = manyWishes();
    render(<WishlistTab />);

    // The list is read whole, so the hundred-and-first wish is on screen…
    expect(screen.getByText('Wish 101')).toBeInTheDocument();
    // …and the estimate above it covers all 140, not a capped 100.
    expect(screen.getByTestId('wishlist-summary').textContent).toContain('140');
    expect(screen.getByTestId('wishlist-summary').textContent).toContain('£140.00');
    expect(screen.queryByTestId('wishlist-truncated')).toBeNull();
  });

  it('pages the loaded list when the preference is on', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 50 });
    rows = manyWishes();
    render(<WishlistTab />);

    expect(screen.getByTestId('wishlist-pagination-summary')).toHaveTextContent('1–50 of 140');
    expect(screen.queryByText('Wish 051')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Wish 051')).toBeInTheDocument();
  });

  it('says the summary is partial when the read-everything ceiling is hit', () => {
    rows = manyWishes();
    truncated = true;
    render(<WishlistTab />);
    expect(screen.getByTestId('wishlist-truncated').textContent).toContain('140');
  });
});
