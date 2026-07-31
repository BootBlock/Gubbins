/**
 * Component tests for the Upcoming agenda screen, covering the two things this screen decides
 * for itself rather than inheriting from the pure seam: the kind filter, and the custom-field
 * due-date lane's **truncation notice** (W1a).
 *
 * The notice matters more than its size suggests. Every other lane on this screen reads one page
 * and shows it as the whole set; the due-date lane instead reads every page and reports when it
 * had to stop (issues #606/#607). That promise is only kept if the screen renders the report —
 * and only against the lane it is about, which is what the filter interaction below pins.
 *
 * `useAgenda` is stubbed (its own suite covers the feeds and gating); the pure `buildAgenda` /
 * `bucketAgenda` seams are the real ones, so what appears here is what a user would see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AgendaEvent } from './agenda';

/** Mutable stub state, so each test can shape the feed without a second `vi.mock` factory. */
let events: AgendaEvent[] = [];
let fieldDueTruncated = false;

vi.mock('./useAgenda', () => ({
  useAgenda: () => ({ events, now: NOW, isLoading: false, isError: false, fieldDueTruncated }),
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

beforeEach(() => {
  events = [FIELD_DUE_EVENT];
  fieldDueTruncated = false;
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
    fieldDueTruncated = true;
    render(<CalendarScreen />);
    expect(screen.getByTestId('agenda-field-due-truncated')).toBeInTheDocument();
  });

  it('says nothing when the whole set was read', () => {
    render(<CalendarScreen />);
    expect(screen.queryByTestId('agenda-field-due-truncated')).toBeNull();
  });

  it('drops the notice when the lane it is about is filtered out', () => {
    // Otherwise it sits above "No items match the selected kinds." contradicting it, warning
    // about a shortfall in a lane the user has just taken off the screen.
    fieldDueTruncated = true;
    render(<CalendarScreen />);
    expect(screen.getByTestId('agenda-field-due-truncated')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agenda-filter-field-due'));

    expect(screen.queryByTestId('agenda-field-due-truncated')).toBeNull();
  });
});
