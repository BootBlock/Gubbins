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
import { render, screen, cleanup } from '@testing-library/react';
import type { CheckoutWithNames } from '@/db/repositories';

// ─── dependency stubs ─────────────────────────────────────────────────────────

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// The global nav menu has its own suite; stub it so this screen test needs no
// router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(
    Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]),
  );
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

let openCheckoutsState: { isLoading: boolean; data?: { rows: CheckoutWithNames[] } } = {
  isLoading: true,
};
let contactsState: { isLoading: boolean; data?: { rows: ContactRow[] } } = {
  isLoading: true,
};

vi.mock('./contacts', () => ({
  useOpenCheckouts: () => openCheckoutsState,
  useContacts: () => contactsState,
  useCreateContact: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckInItem: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ─── component under test ─────────────────────────────────────────────────────

import { ContactsScreen } from './ContactsScreen';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCheckout(id: string, overdue: boolean): CheckoutWithNames {
  return {
    id,
    itemId: 'item-1',
    itemName: 'Soldering Iron',
    contactId: 'contact-1',
    contactName: 'Alice',
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
