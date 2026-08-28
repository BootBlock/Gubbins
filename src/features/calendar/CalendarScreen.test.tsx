/**
 * Component tests for the Upcoming agenda screen, covering the three things this screen decides
 * for itself rather than inheriting from the pure seam: the kind filter, the **truncation
 * notice**, and the **look-back note** over the Overdue bucket.
 *
 * The two notices matter more than their size suggests. Every lane reads every page and reports
 * when it had to stop, and the two dated item lanes reach back a bounded distance (issues
 * #606/#607). Those promises are only kept if the screen renders the report — and only against
 * the lanes it is about, which is what the filter interactions below pin.
 *
 * `useAgenda` is stubbed (its own suite covers the feeds and gating); the pure `buildAgenda` /
 * `bucketAgenda` seams are the real ones, so what appears here is what a user would see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AgendaEvent, AgendaKind } from './agenda';

/** Mutable stub state, so each test can shape the feed without a second `vi.mock` factory. */
let events: AgendaEvent[] = [];
let truncatedKinds = new Set<AgendaKind>();

vi.mock('./useAgenda', () => ({
  useAgenda: () => ({
    events,
    now: NOW,
    isLoading: false,
    isError: false,
    truncatedKinds,
    lookbackDays: 365,
  }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ date: (ms: number) => new Date(ms).toISOString().slice(0, 10) }),
}));

// Stub the router Link so the screen renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// The global nav menu has its own suite; stub it so this test needs no router context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

import { CalendarScreen } from './CalendarScreen';

const NOW = Date.parse('2026-06-30T12:00:00Z');

const FIELD_DUE_EVENT: AgendaEvent = {
  id: 'field-due:policy-1:def-1',
  kind: 'field-due',
  title: 'Renewal date — Studio insurance',
  detail: 'Due 2026-07-02.',
  dueAt: NOW + 2 * 24 * 60 * 60 * 1000,
  hasDate: true,
  target: { route: '/inventory', itemId: 'policy-1' },
};

/** An expired warranty, so the Overdue bucket exists for the look-back note to sit under. */
const OVERDUE_WARRANTY_EVENT: AgendaEvent = {
  id: 'warranty:drill-1',
  kind: 'warranty',
  title: 'Warranty expired — Bench drill',
  detail: 'Expired 2026-06-01.',
  dueAt: NOW - 29 * 24 * 60 * 60 * 1000,
  hasDate: true,
  target: { route: '/inventory', itemId: 'drill-1' },
};

beforeEach(() => {
  events = [FIELD_DUE_EVENT];
  truncatedKinds = new Set<AgendaKind>();
});

afterEach(cleanup);

describe('CalendarScreen — the custom-field due-date lane', () => {
  it('lists an opted-in field date, naming the field so several stay tellable apart', () => {
    render(<CalendarScreen />);
    expect(screen.getByText('Renewal date — Studio insurance')).toBeInTheDocument();
  });

  it('offers a filter chip for the lane, which hides it', () => {
    render(<CalendarScreen />);
    fireEvent.click(screen.getByTestId('agenda-filter-field-due'));
    expect(screen.queryByText('Renewal date — Studio insurance')).toBeNull();
  });
});

describe('CalendarScreen — truncation is reported, not swallowed', () => {
  it('says so when the read hit its ceiling', () => {
    truncatedKinds = new Set<AgendaKind>(['field-due']);
    render(<CalendarScreen />);
    expect(screen.getByTestId('agenda-truncated')).toBeInTheDocument();
  });

  it('says nothing when the whole set was read', () => {
    render(<CalendarScreen />);
    expect(screen.queryByTestId('agenda-truncated')).toBeNull();
  });

  it('names every capped lane, so one notice does not stand for another', () => {
    events = [FIELD_DUE_EVENT, OVERDUE_WARRANTY_EVENT];
    truncatedKinds = new Set<AgendaKind>(['warranty', 'field-due']);
    render(<CalendarScreen />);
    // Chip order, not Set insertion order — the caveat reads in the sequence of the filter row.
    expect(screen.getByTestId('agenda-truncated')).toHaveTextContent('Warranty, Field dates');
  });

  it('drops the notice when the lane it is about is filtered out', () => {
    // Otherwise it sits above "No items match the selected kinds." contradicting it, warning
    // about a shortfall in a lane the user has just taken off the screen.
    truncatedKinds = new Set<AgendaKind>(['field-due']);
    render(<CalendarScreen />);
    expect(screen.getByTestId('agenda-truncated')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agenda-filter-field-due'));

    expect(screen.queryByTestId('agenda-truncated')).toBeNull();
  });

  it('keeps the notice for a still-shown lane when another capped lane is filtered out', () => {
    events = [FIELD_DUE_EVENT, OVERDUE_WARRANTY_EVENT];
    truncatedKinds = new Set<AgendaKind>(['warranty', 'field-due']);
    render(<CalendarScreen />);

    fireEvent.click(screen.getByTestId('agenda-filter-warranty'));

    expect(screen.getByTestId('agenda-truncated')).toHaveTextContent('Field dates');
    expect(screen.getByTestId('agenda-truncated')).not.toHaveTextContent('Warranty');
  });
});

describe('CalendarScreen — the look-back bound on the dated item lanes', () => {
  it('names the window as a footnote under the agenda', () => {
    events = [OVERDUE_WARRANTY_EVENT];
    render(<CalendarScreen />);
    expect(screen.getByTestId('agenda-lookback')).toHaveTextContent('365');
  });

  it('says nothing when neither bounded lane is showing', () => {
    // With both chips off the note describes a boundary on nothing the reader can see.
    events = [OVERDUE_WARRANTY_EVENT];
    render(<CalendarScreen />);
    expect(screen.getByTestId('agenda-lookback')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agenda-filter-warranty'));
    fireEvent.click(screen.getByTestId('agenda-filter-expiry'));

    expect(screen.queryByTestId('agenda-lookback')).toBeNull();
  });

  it('says nothing on an empty agenda', () => {
    events = [];
    render(<CalendarScreen />);
    expect(screen.queryByTestId('agenda-lookback')).toBeNull();
  });
});
