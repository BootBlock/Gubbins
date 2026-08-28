/**
 * Query-key SSOT for the §3 "Upcoming" agenda.
 *
 * Every agenda lane hangs off the `['agenda', …]` prefix, so invalidating the prefix refreshes
 * the whole screen at once. This lives in its own dependency-free module (rather than in
 * `./useAgenda`, which pulls the repositories, the modules store and the formatter seam) so the
 * write side — inventory, lifecycle, contacts, purchasing, bookings — can import the prefix
 * without dragging the read hook in.
 *
 * The prefix used to be re-typed as a bare `['agenda']` literal at its single write site, which
 * is how five of the six lanes came to be refreshed by nothing at all (issue #374); building
 * every key here is what stops a lane drifting out from under the sweep unnoticed.
 */
export const agendaKeys = {
  /** The prefix every agenda lane is built from; invalidate this to refresh them all. */
  all: ['agenda'] as const,
  maintenance: () => [...agendaKeys.all, 'maintenance'] as const,
  /**
   * The two dated item lanes are bounded at *both* ends (issue #607), so both bounds are part of
   * the key — a cached page read under a different window is a different set of rows.
   */
  warranty: (lookaheadDays: number, lookbackDays: number) =>
    [...agendaKeys.all, 'warranty', lookaheadDays, lookbackDays] as const,
  expiry: (lookaheadDays: number, lookbackDays: number) =>
    [...agendaKeys.all, 'expiry', lookaheadDays, lookbackDays] as const,
  checkouts: () => [...agendaKeys.all, 'checkouts'] as const,
  reorder: () => [...agendaKeys.all, 'reorder'] as const,
  bookings: () => [...agendaKeys.all, 'bookings'] as const,
  /** Opted-in custom-field due dates (W1a), under one shared lookahead horizon. */
  fieldDue: (lookaheadDays: number) => [...agendaKeys.all, 'field-due', lookaheadDays] as const,
} as const;
