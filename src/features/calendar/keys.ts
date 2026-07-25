/**
 * Query-key SSOT for the "Upcoming" agenda (Phase 75).
 *
 * The agenda is six independent feeds under one `['agenda', …]` prefix, so invalidating the
 * prefix refreshes the whole screen at once. Like `@/features/reports/keys` this lives in its
 * own dependency-free module rather than beside {@link useAgenda}, so the write side — a
 * booking, a checkout, a maintenance log — can import the prefix without pulling in the read
 * hook and its repositories.
 *
 * Every feed has a named member here, so the set of things the agenda reads is enumerable in
 * one place: adding a feed without a key to hang it on, or a write that refreshes only some of
 * them, is visible here rather than spread between six call sites (issue #379).
 */
export const agendaKeys = {
  /** The prefix every agenda feed is built from; invalidate this to refresh them all. */
  all: ['agenda'] as const,
  maintenance: () => [...agendaKeys.all, 'maintenance'] as const,
  warranty: (lookaheadDays: number) => [...agendaKeys.all, 'warranty', lookaheadDays] as const,
  expiry: (lookaheadDays: number) => [...agendaKeys.all, 'expiry', lookaheadDays] as const,
  checkouts: () => [...agendaKeys.all, 'checkouts'] as const,
  reorder: () => [...agendaKeys.all, 'reorder'] as const,
  bookings: () => [...agendaKeys.all, 'bookings'] as const,
} as const;
