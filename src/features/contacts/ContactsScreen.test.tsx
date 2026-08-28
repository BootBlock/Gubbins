/**
 * Component tests for ContactsScreen — WCAG 4.1.3 aria-live result-count coverage
 * (Phase 64 — aria-live Tier B). Verifies that:
 *  1. Both live regions (on-loan count and contacts count) are always mounted
 *     before data loads.
 *  2. Each region announces the correct count once its query resolves.
 *  3. Each region announces the empty state appropriately.
 *  4. The on-loan region calls out overdue loans specifically.
 *
 * All dependencies are mocked at the module boundary so no DB or QueryClient
 * is needed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CheckoutWithNames } from '@/db/repositories';

// ─── dependency stubs ─────────────────────────────────────────────────────────

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care that the screen offers one per list.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

// The global nav menu has its own suite; stub it so this screen test needs no
// router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    quantity: (v: number) => String(v),
    date: () => '01 Jan 2026',
  }),
}));

// ─── controlled query stubs ───────────────────────────────────────────────────

type ContactRow = { id: string; name: string; openCount: number };

let openCheckoutsState: { isLoading: boolean; isError?: boolean; data?: { rows: CheckoutWithNames[] } } = {
  isLoading: true,
};
let contactsState: { isLoading: boolean; isError?: boolean; data?: { rows: ContactRow[] } } = {
  isLoading: true,
};
/** Overrides the contacts total when a test needs it to disagree with the rows it supplies. */
let contactCountState: number | undefined;
/** The same, for the loan board's totals — the case a page of loans cannot show (issue #606). */
let openCountState: { open: number; overdue: number } | undefined;
const refetchOpen = vi.fn();
const refetchContacts = vi.fn();

vi.mock('./contacts', () => ({
  useOpenCheckouts: () => ({ ...openCheckoutsState, refetch: refetchOpen }),
  /**
   * The loan board's totals (issue #606). Defaults to what a real `COUNT(*)` would say about the
   * fixture; a test that needs the board to be longer than the page overrides it. It tracks the
   * feed's own loading/error state, since both come from the same bounded read on screen.
   */
  useOpenCheckoutCounts: () => {
    const rows = openCheckoutsState.data?.rows ?? [];
    return {
      isLoading: openCheckoutsState.isLoading,
      isError: openCheckoutsState.isError,
      data: openCheckoutsState.data
        ? (openCountState ?? { open: rows.length, overdue: rows.filter((r) => r.isOverdue).length })
        : undefined,
    };
  },
  // The export's read-everything walk (issue #132); never invoked here, as the menu is stubbed.
  readOpenCheckoutsPage: vi.fn(),
  readContactsPage: vi.fn(),
  /**
   * The dictionary now pages **server-side** (issue #149), so the stub serves pages the way the
   * repository does: `contactsState.data.rows` is the whole dictionary, and the hook returns
   * only the requested window of it, capped at the repository's ceiling. A test that hands it
   * more rows than one page holds therefore sees exactly what the screen would really get.
   */
  useContacts: (page = 1, pageSize = 100) => {
    if (!contactsState.data) return { ...contactsState, refetch: refetchContacts };
    const all = contactsState.data.rows;
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;
    const rows = all.slice(offset, offset + limit);
    return {
      ...contactsState,
      data: { rows, offset, limit, hasMore: offset + rows.length < all.length },
      refetch: refetchContacts,
    };
  },
  // The total across every page. Defaults to the whole fixture, as the real COUNT(*) would.
  useContactCount: () => ({ data: contactCountState ?? contactsState.data?.rows.length }),
  useCreateContact: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckInItem: () => ({ mutate: vi.fn(), isPending: false }),
  useRenewLoan: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteContact: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ─── component under test ─────────────────────────────────────────────────────

import { ContactsScreen } from './ContactsScreen';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCheckout(id: string, overdue: boolean): CheckoutWithNames {
  return {
    id,
    itemId: 'item-1',
    itemName: 'Soldering Iron',
    borrowerType: 'contact',
    contactId: 'contact-1',
    projectId: null,
    locationId: null,
    borrowerName: 'Alice',
    quantity: 1,
    checkedOutAt: 0,
    dueDate: null,
    returnedAt: null,
    note: null,
    sourceLocationId: null,
    sourceBatchKey: null,
    updatedAt: 0,
    status: 'OPEN',
    isOverdue: overdue,
  };
}

function makeContact(id: string, name: string, openCount = 0): ContactRow {
  return { id, name, openCount };
}

afterEach(cleanup);

beforeEach(() => {
  openCheckoutsState = { isLoading: true };
  contactsState = { isLoading: true };
  contactCountState = undefined;
  openCountState = undefined;
  refetchOpen.mockClear();
  refetchContacts.mockClear();
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ContactsScreen — aria-live result-count regions (WCAG 4.1.3, Phase 64)', () => {
  it('mounts the on-loan live region before data resolves', () => {
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-on-loan-live');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('mounts the contacts live region before data resolves', () => {
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-count-live');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('both live regions are visually hidden (sr-only)', () => {
    render(<ContactsScreen />);
    expect(screen.getByTestId('contacts-on-loan-live').className).toContain('sr-only');
    expect(screen.getByTestId('contacts-count-live').className).toContain('sr-only');
  });

  it('announces "Loading" for on-loan while the query is in-flight', () => {
    openCheckoutsState = { isLoading: true };
    render(<ContactsScreen />);
    expect(screen.getByTestId('contacts-on-loan-live').textContent?.toLowerCase()).toContain('loading');
  });

  it('announces empty on-loan state when nothing is checked out', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [] } };
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-on-loan-live');
    expect(region.textContent?.toLowerCase()).toContain('nothing');
  });

  it('announces on-loan count correctly', () => {
    openCheckoutsState = {
      isLoading: false,
      data: { rows: [makeCheckout('c1', false), makeCheckout('c2', false)] },
    };
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-on-loan-live');
    expect(region.textContent).toContain('2');
    expect(region.textContent?.toLowerCase()).toContain('on loan');
  });

  it('includes overdue count in the on-loan announcement', () => {
    openCheckoutsState = {
      isLoading: false,
      data: { rows: [makeCheckout('c1', true), makeCheckout('c2', false)] },
    };
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-on-loan-live');
    expect(region.textContent?.toLowerCase()).toContain('overdue');
    expect(region.textContent).toContain('1');
  });

  it('announces empty contacts state', () => {
    contactsState = { isLoading: false, data: { rows: [] } };
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-count-live');
    expect(region.textContent?.toLowerCase()).toContain('no contacts');
  });

  it('announces the contacts count once loaded', () => {
    contactsState = {
      isLoading: false,
      data: { rows: [makeContact('k1', 'Alice'), makeContact('k2', 'Bob'), makeContact('k3', 'Carol')] },
    };
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-count-live');
    expect(region.textContent).toContain('3');
    expect(region.textContent?.toLowerCase()).toContain('contact');
  });

  it('uses singular form for exactly one contact', () => {
    contactsState = {
      isLoading: false,
      data: { rows: [makeContact('k1', 'Solo')] },
    };
    render(<ContactsScreen />);
    const region = screen.getByTestId('contacts-count-live');
    expect(region.textContent).toContain('1 contact');
    expect(region.textContent).not.toContain('1 contacts');
  });
});

describe('ContactsScreen — list pagination (issue #20)', () => {
  afterEach(() => {
    // Reset the app-wide preference so it can't leak into the other describe blocks.
    usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
  });

  const twelveContacts = {
    isLoading: false,
    data: {
      rows: Array.from({ length: 12 }, (_, i) =>
        makeContact(`k${i}`, `Contact ${String(i + 1).padStart(2, '0')}`),
      ),
    },
  };

  it('does not paginate when the preference is off (all contacts shown, no control)', () => {
    contactsState = twelveContacts;
    render(<ContactsScreen />);
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    expect(screen.getByText('Contact 12')).toBeInTheDocument();
  });

  it('splits the dictionary into pages and steps between them when the preference is on', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 5 });
    contactsState = twelveContacts;
    render(<ContactsScreen />);

    // Page 1 shows the first five; the sixth is on a later page.
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    expect(screen.getByTestId('contacts-pagination-summary')).toHaveTextContent('1–5 of 12');
    expect(screen.getByText('Contact 05')).toBeInTheDocument();
    expect(screen.queryByText('Contact 06')).toBeNull();

    // Next reveals the following page.
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('contacts-pagination-summary')).toHaveTextContent('6–10 of 12');
    expect(screen.getByText('Contact 06')).toBeInTheDocument();
    expect(screen.queryByText('Contact 05')).toBeNull();
  });
});

/**
 * The loan board is read one bounded page at a time, exactly as the dictionary beneath it is,
 * but it had neither a pager nor a notice — so a board longer than a page showed a hundred rows
 * as though they were every loan, under a summary that counted them (issue #606).
 */
describe('ContactsScreen — a loan board longer than one read (issue #606)', () => {
  it('states the whole board in the summary, not the page in view', () => {
    openCheckoutsState = {
      isLoading: false,
      data: { rows: Array.from({ length: 100 }, (_, i) => makeCheckout(`k${i}`, i < 4)) },
    };
    openCountState = { open: 300, overdue: 20 };
    render(<ContactsScreen />);

    expect(screen.getByTestId('contacts-on-loan-live').textContent).toBe('300 items on loan, 20 overdue.');
  });

  it('says how many loans the capped read leaves out', () => {
    openCheckoutsState = {
      isLoading: false,
      data: { rows: Array.from({ length: 100 }, (_, i) => makeCheckout(`k${i}`, false)) },
    };
    openCountState = { open: 300, overdue: 0 };
    render(<ContactsScreen />);

    const notice = screen.getByTestId('loans-truncated');
    expect(notice.textContent).toContain('100');
    expect(notice.textContent).toContain('200');
  });

  it('says nothing when the whole board fits in one read', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [makeCheckout('k1', false)] } };
    render(<ContactsScreen />);

    expect(screen.queryByTestId('loans-truncated')).toBeNull();
  });
});

describe('ContactsScreen — a dictionary longer than one read (issue #149)', () => {
  afterEach(() => {
    usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
  });

  /** 140 contacts — more than the repository will return in a single capped read. */
  const manyContacts = {
    isLoading: false,
    data: {
      rows: Array.from({ length: 140 }, (_, i) =>
        makeContact(`k${i}`, `Contact ${String(i + 1).padStart(3, '0')}`),
      ),
    },
  };

  it('says how many contacts the capped read leaves out when pagination is off', () => {
    contactsState = manyContacts;
    render(<ContactsScreen />);

    // The read stops at 100, so 40 contacts are unreachable — the screen must not simply show
    // a hundred cards and let the rest vanish.
    const notice = screen.getByTestId('contacts-truncated');
    expect(notice.textContent).toContain('100');
    expect(notice.textContent).toContain('40');
    expect(screen.queryByText('Contact 101')).toBeNull();
  });

  it('reports the whole dictionary in the live region, not just the page in view', () => {
    contactsState = manyContacts;
    render(<ContactsScreen />);
    expect(screen.getByTestId('contacts-count-live').textContent).toContain('140 contacts');
  });

  it('reaches the contacts past the first read once pagination is on', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 100 });
    contactsState = manyContacts;
    render(<ContactsScreen />);

    // No truncation notice — the pager is how the rest is reached now.
    expect(screen.queryByTestId('contacts-truncated')).toBeNull();
    expect(screen.getByTestId('contacts-pagination-summary')).toHaveTextContent('1–100 of 140');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('contacts-pagination-summary')).toHaveTextContent('101–140 of 140');
    expect(screen.getByText('Contact 101')).toBeInTheDocument();
  });

  it('shows no truncation notice when the dictionary fits in one read', () => {
    contactsState = { isLoading: false, data: { rows: [makeContact('k1', 'Alice')] } };
    render(<ContactsScreen />);
    expect(screen.queryByTestId('contacts-truncated')).toBeNull();
  });

  it('falls back to the first page when pagination is switched off mid-visit', () => {
    // Settings is a modal, so turning the preference off leaves this screen mounted with a page
    // still selected. Reading that page while the notice says "the first 100" would show rows
    // 101–140 under copy claiming they are the first hundred.
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 100 });
    contactsState = manyContacts;
    const view = render(<ContactsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Contact 140')).toBeInTheDocument();

    usePreferencesStore.setState({ paginateLists: false });
    view.rerender(<ContactsScreen />);

    expect(screen.getByText('Contact 001')).toBeInTheDocument();
    expect(screen.queryByText('Contact 140')).toBeNull();
    expect(screen.getByTestId('contacts-truncated').textContent).toContain('40');
  });
});

describe('ContactsScreen — first-run guide (#424)', () => {
  it('shows the guide once both lists are confirmed empty', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [] } };
    contactsState = { isLoading: false, data: { rows: [] } };
    render(<ContactsScreen />);
    expect(screen.getByTestId('contacts-getting-started')).toBeTruthy();
  });

  it('hides the guide while either query is still loading', () => {
    openCheckoutsState = { isLoading: true };
    contactsState = { isLoading: false, data: { rows: [] } };
    render(<ContactsScreen />);
    expect(screen.queryByTestId('contacts-getting-started')).toBeNull();
  });

  it('hides the guide once something is on loan', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [makeCheckout('c1', false)] } };
    contactsState = { isLoading: false, data: { rows: [] } };
    render(<ContactsScreen />);
    expect(screen.queryByTestId('contacts-getting-started')).toBeNull();
  });

  it('hides the guide once a contact exists', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [] } };
    contactsState = { isLoading: false, data: { rows: [makeContact('k1', 'Alice')] } };
    render(<ContactsScreen />);
    expect(screen.queryByTestId('contacts-getting-started')).toBeNull();
  });
});

describe('ContactsScreen — failed loads (issue #306)', () => {
  it('reports a failed on-loan load instead of "nothing checked out"', () => {
    openCheckoutsState = { isLoading: false, isError: true };
    contactsState = { isLoading: false, data: { rows: [] } };
    render(<ContactsScreen />);
    const alerts = screen.getAllByRole('alert').map((el) => el.textContent);
    expect(alerts.some((text) => text?.includes('loans couldn’t be loaded'))).toBe(true);
    expect(screen.queryByText(/Nothing is currently checked out/)).toBeNull();
  });

  it('reports a failed contacts load instead of "no contacts yet"', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [] } };
    contactsState = { isLoading: false, isError: true };
    render(<ContactsScreen />);
    const alerts = screen.getAllByRole('alert').map((el) => el.textContent);
    expect(alerts.some((text) => text?.includes('contacts couldn’t be loaded'))).toBe(true);
    expect(screen.queryByText(/No contacts yet/)).toBeNull();
  });

  it('does not show the first-run guide when a load failed', () => {
    // Both lists come back empty on failure, which used to look identical to a brand-new
    // account and wrongly greeted a returning user with the getting-started guide.
    openCheckoutsState = { isLoading: false, isError: true };
    contactsState = { isLoading: false, isError: true };
    render(<ContactsScreen />);
    expect(screen.queryByTestId('contacts-getting-started')).toBeNull();
  });

  it('each failed list offers a retry that refetches its own query', () => {
    openCheckoutsState = { isLoading: false, isError: true };
    contactsState = { isLoading: false, isError: true };
    render(<ContactsScreen />);
    const retries = screen.getAllByRole('button', { name: 'Try again' });
    expect(retries).toHaveLength(2);
    fireEvent.click(retries[0]!);
    fireEvent.click(retries[1]!);
    expect(refetchOpen).toHaveBeenCalled();
    expect(refetchContacts).toHaveBeenCalled();
  });
});

describe('ContactsScreen — renew loan affordance (B3)', () => {
  it('opens the renew dialog seeded from the loan when "Renew" is clicked', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [makeCheckout('c1', false)] } };
    render(<ContactsScreen />);

    // The dialog is not mounted until the row's Renew affordance is used.
    expect(screen.queryByTestId('renew-due-date')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /renew/i }));
    expect(screen.getByTestId('renew-due-date')).toBeTruthy();
  });
});

/**
 * Both of this screen's lists export separately (issue #132) — a loan row is about an item and a
 * contact row is about a person, so one merged file would be half-empty on every row. The menus
 * are stubbed (their download + toast machinery has its own suite); these assert what the screen
 * owns: that there are two controls, and that each is gated on *its own* list.
 */
describe('ContactsScreen — export', () => {
  it('offers a separate export for each of the two lists', () => {
    openCheckoutsState = { isLoading: false, data: { rows: [makeCheckout('k1', false)] } };
    contactsState = { isLoading: false, data: { rows: [makeContact('c1', 'Alex Rivera')] } };
    render(<ContactsScreen />);

    expect(screen.getByTestId('export-loans')).not.toBeDisabled();
    expect(screen.getByTestId('export-contacts')).not.toBeDisabled();
  });

  it('gates each control on its own list, not the other', () => {
    // Nothing on loan but contacts on file: only the loans export goes dark. Sharing one gate
    // would wrongly disable an export that has plenty to write.
    openCheckoutsState = { isLoading: false, data: { rows: [] } };
    contactsState = { isLoading: false, data: { rows: [makeContact('c1', 'Alex Rivera')] } };
    render(<ContactsScreen />);

    expect(screen.getByTestId('export-loans')).toBeDisabled();
    expect(screen.getByTestId('export-contacts')).not.toBeDisabled();
  });
});
