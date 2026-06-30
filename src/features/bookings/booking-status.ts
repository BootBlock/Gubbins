/**
 * Asset-booking lifecycle pure seam (Phase 78, third feature-gap audit Wave-2 candidate #2).
 *
 * A booking is a calendar reservation of a single identifiable asset over a whole-day window.
 * Its lifecycle *status* is **derived**, never stored as an enum — exactly mirroring how a
 * checkout derives OPEN/RETURNED from a single nullable `returned_at` column (see
 * `CHECKOUT_STATUSES` in `@/db/repositories/constants`). Here the status falls out of the
 * date window plus two stored nullable columns: `cancelledAt` (the booking was called off) and
 * `convertedCheckoutId` (the booking was realised into an actual checkout). Keeping the logic
 * pure (`now` injected, no DB / React / DOM) makes every branch and boundary exhaustively
 * unit-testable, just like `agenda.ts`, `alerts.ts` and `reports.ts`.
 *
 * **Tokens only.** The tone/badge maps below use design-token Tailwind utilities
 * (`text-destructive`, `bg-primary/10`, …) — never raw colour literals — so the calendar stays
 * themable and dark-mode-correct (see CLAUDE.md "Design tokens are mandatory").
 */
import { MS_PER_DAY } from '@/db/repositories/constants';

// ---------------------------------------------------------------------------
// Status type & input
// ---------------------------------------------------------------------------

/**
 * A booking's derived lifecycle state. `cancelled`/`converted` are the two terminal stored
 * states (a nullable column each); the remaining three are purely a function of `now` versus
 * the booked whole-day window.
 */
export type BookingStatus = 'cancelled' | 'converted' | 'overdue' | 'active' | 'upcoming';

/**
 * The minimal stored slice a booking's status is derived from. `startDate`/`endDate` are
 * day-start (local midnight) UNIX-ms instants, both **inclusive** — the booking covers every
 * whole day from `startDate` up to and including the day containing `endDate`.
 */
export interface BookingStatusInput {
  /** Day-start (local midnight) UNIX-ms — first booked day, inclusive. */
  readonly startDate: number;
  /** Day-start (local midnight) UNIX-ms — last booked day, inclusive of that whole day. */
  readonly endDate: number;
  /** UNIX-ms the booking was cancelled, or null if it was not. Takes precedence over all. */
  readonly cancelledAt: number | null;
  /** Id of the checkout this booking became, or null if not yet realised. */
  readonly convertedCheckoutId: string | null;
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

/**
 * Start of the local calendar day containing `ms` (local midnight, UNIX-ms). Self-contained so
 * the seam has no cross-file dependency; pure given `ms` and the host time zone. Unit tests
 * derive their instants from this same anchor so they hold in any time zone.
 */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Derive a booking's lifecycle status. Resolution order (first match wins):
 *
 * 1. `cancelledAt != null` → **cancelled** (a terminal stored state; beats everything).
 * 2. `convertedCheckoutId != null` → **converted** (realised into a checkout; beats dates).
 * 3. Otherwise date-based, comparing `now` to the booked whole-day window. The window runs
 *    from `startDate` (inclusive) to the END of the day containing `endDate`, i.e.
 *    `endExclusive = startOfLocalDay(endDate) + MS_PER_DAY`:
 *    - `now >= endExclusive` → **overdue** (the window fully passed, never converted/cancelled).
 *    - `now >= startDate` (and `now < endExclusive`) → **active** (in use today).
 *    - else (`now < startDate`) → **upcoming**.
 */
export function deriveBookingStatus(b: BookingStatusInput, now: number): BookingStatus {
  if (b.cancelledAt != null) return 'cancelled';
  if (b.convertedCheckoutId != null) return 'converted';
  const endExclusive = startOfLocalDay(b.endDate) + MS_PER_DAY;
  if (now >= endExclusive) return 'overdue';
  if (now >= b.startDate) return 'active';
  return 'upcoming';
}

// ---------------------------------------------------------------------------
// Display metadata (British English labels; token-only tone & badge classes)
// ---------------------------------------------------------------------------

/** Human-readable status labels (British English). */
export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  cancelled: 'Cancelled',
  converted: 'Checked out',
  overdue: 'Overdue',
  active: 'In use',
  upcoming: 'Upcoming',
};

/**
 * Text-tone Tailwind classes per status — design tokens only (no raw colour literals), so the
 * calendar stays themable and dark-mode-correct.
 */
export const BOOKING_STATUS_TONE: Record<BookingStatus, string> = {
  cancelled: 'text-muted-foreground',
  converted: 'text-muted-foreground',
  overdue: 'text-destructive',
  active: 'text-primary',
  upcoming: 'text-foreground',
};

/**
 * Badge (background + text) Tailwind classes per status, mirroring the `BUCKET_BADGE` pattern
 * in `CalendarScreen.tsx`. Tokens only — themable, dark-mode-correct, contrast-safe.
 */
export const BOOKING_STATUS_BADGE: Record<BookingStatus, string> = {
  cancelled: 'bg-muted text-muted-foreground',
  converted: 'bg-muted text-muted-foreground',
  overdue: 'bg-destructive/10 text-destructive',
  active: 'bg-primary/10 text-primary',
  upcoming: 'bg-muted text-muted-foreground',
};

// ---------------------------------------------------------------------------
// Bookability & display order
// ---------------------------------------------------------------------------

/**
 * Whether an item's tracking mode permits a calendar booking. A reservation only makes sense
 * for a single identifiable unit, so:
 * - `SERIALISED` — always bookable (quantity is forced to 1).
 * - `DISCRETE` — bookable only when `quantity === 1` (one identifiable unit).
 * - `CONSUMABLE_GAUGE`, any multi-unit DISCRETE, or an unknown mode — not bookable.
 *
 * See `TrackingMode` in `@/db/repositories/constants`. `mode` is typed as `string` so a raw
 * stored value can be passed without first narrowing it.
 */
export function isBookableTrackingMode(mode: string, quantity: number): boolean {
  if (mode === 'SERIALISED') return true;
  if (mode === 'DISCRETE') return quantity === 1;
  return false;
}

/** Every booking status in display order — open states first, terminal states last. */
export const BOOKING_STATUSES: readonly BookingStatus[] = [
  'upcoming',
  'active',
  'overdue',
  'converted',
  'cancelled',
];
