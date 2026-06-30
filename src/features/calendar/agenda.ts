/**
 * Unified "Upcoming" agenda pure seam (Phase 75, third feature-gap audit candidate #1).
 *
 * Folds every date-driven event in the app — maintenance due (time + usage), warranty
 * expiry, perishable expiry, checkout due-back and reorder-now — into ONE chronological,
 * time-ordered agenda. Today these live scattered across the alert centre and the dashboard
 * widgets; there is no single time-ordered view. This is the "logic out of the glue" half:
 * pure (`now` injected, no DB / React / DOM), so the lane builders and the date bucketing are
 * exhaustively unit-testable, exactly like `alerts.ts`, `expiry.ts` and `reports.ts`.
 *
 * **Read-only.** No schema change — every source is an existing repository query. The matching
 * `useAgenda` hook fetches the five feeds and runs {@link buildAgenda} + {@link bucketAgenda}.
 *
 * **Date-less actionable events.** Reorder-now (a present *state*, not a date) and a USAGE
 * maintenance schedule that is currently due (no calendar date) carry `hasDate: false` and are
 * anchored at `now`, so they sort and bucket into "Today" rather than being hidden.
 */
import { MS_PER_DAY } from '@/db/repositories/constants';
import { maintenanceDueAtMs } from '@/features/alerts/alerts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The six date-driven event categories the agenda aggregates. */
export type AgendaKind =
  | 'maintenance'
  | 'warranty'
  | 'expiry'
  | 'checkout-due'
  | 'reorder'
  | 'booking';

/** Chronological buckets, in display order. "Later" is a catch-all so nothing is hidden. */
export type AgendaBucket = 'overdue' | 'today' | 'week' | 'month' | 'later';

/** Deep-link target so an event can jump the user to the relevant resource. */
export interface AgendaTarget {
  /** TanStack Router path, e.g. `'/inventory'`. */
  readonly route: string;
  /** Optional item id for filtering / pre-selecting on the destination screen. */
  readonly itemId?: string;
}

/** A single date-driven event in the agenda. */
export interface AgendaEvent {
  /** Deterministic id (`kind:sourceId`) — stable for the same underlying condition. */
  readonly id: string;
  readonly kind: AgendaKind;
  readonly title: string;
  /** Supplementary copy (the item, the date, the shortfall, …). */
  readonly detail: string;
  /**
   * UNIX-ms instant the event is anchored at — its real due date when {@link hasDate} is
   * true, else `now` (a present-state action: reorder-now / a due USAGE schedule).
   */
  readonly dueAt: number;
  /** False ⇒ the event has no real calendar date (anchored at `now`, "due now"). */
  readonly hasDate: boolean;
  readonly target: AgendaTarget;
}

// ---------------------------------------------------------------------------
// Source shapes (minimal slices — the hook maps its repository DTOs to these)
// ---------------------------------------------------------------------------

/**
 * A maintenance schedule for the agenda. TIME schedules carry a calendar `dueAtMs`; USAGE
 * schedules have none, so the hook pre-computes `usageDue` (currently due) via the lifecycle
 * maths and the lane only surfaces a USAGE schedule when it is actually due.
 */
export interface MaintenanceAgendaSource {
  readonly scheduleId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly scheduleName: string;
  /** TIME basis: the instant it falls/fell due (UNIX-ms). Null for USAGE schedules. */
  readonly dueAtMs: number | null;
  /** USAGE basis: whether the schedule is currently due (no calendar date). */
  readonly usageDue: boolean;
}

/** An item with a warranty expiry (Phase-66 field). */
export interface WarrantyAgendaSource {
  readonly id: string;
  readonly name: string;
  /** ISO 'YYYY-MM-DD' warranty expiry; null/absent ⇒ no warranty event. */
  readonly warrantyExpiresAt: string | null;
}

/** A perishable item with an expiry instant. */
export interface ExpiryAgendaSource {
  readonly id: string;
  readonly name: string;
  /** UNIX-ms expiry instant; null ⇒ no expiry event. */
  readonly expiryDate: number | null;
}

/** An open checkout with a due-back date. */
export interface CheckoutAgendaSource {
  readonly id: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly contactName: string;
  /** UNIX-ms due-back date; null ⇒ no due-back event (open-ended loan). */
  readonly dueDate: number | null;
}

/** An item below its reorder point (a present "reorder now" state). */
export interface ReorderAgendaSource {
  readonly itemId: string;
  readonly itemName: string;
  /** Units below the reorder point (already computed by the reorder policy). */
  readonly shortfall: number;
}

/** An active asset booking (Phase 78) — a calendar reservation of one identifiable asset. */
export interface BookingAgendaSource {
  readonly id: string;
  readonly itemId: string;
  readonly itemName: string;
  /** Optional contact the asset is reserved for. */
  readonly contactName: string | null;
  /** Day-start UNIX-ms of the first booked day (inclusive). */
  readonly startDate: number;
  /** Day-start UNIX-ms of the last booked day (inclusive). */
  readonly endDate: number;
}

/** The six pre-fetched source arrays passed to {@link buildAgenda}. */
export interface AgendaSources {
  readonly maintenance: readonly MaintenanceAgendaSource[];
  readonly warranty: readonly WarrantyAgendaSource[];
  readonly expiry: readonly ExpiryAgendaSource[];
  readonly checkouts: readonly CheckoutAgendaSource[];
  readonly reorder: readonly ReorderAgendaSource[];
  readonly bookings: readonly BookingAgendaSource[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** ISO date (YYYY-MM-DD) of a UNIX-ms instant, for terse human-readable detail copy. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Lane builders (pure; each emits zero or one event per source row)
// ---------------------------------------------------------------------------

function buildMaintenanceEvents(
  sources: readonly MaintenanceAgendaSource[],
  now: number,
): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    let dueAt: number;
    let hasDate: boolean;
    let detail: string;
    if (s.dueAtMs != null) {
      // TIME schedule — a real calendar due date (past or future).
      dueAt = s.dueAtMs;
      hasDate = true;
      detail = `Schedule "${s.scheduleName}" — due ${isoDate(s.dueAtMs)}.`;
    } else if (s.usageDue) {
      // USAGE schedule with no calendar date — surfaced only while actually due.
      dueAt = now;
      hasDate = false;
      detail = `Schedule "${s.scheduleName}" — usage interval reached.`;
    } else {
      continue; // a USAGE schedule not yet due has no place on a time-ordered agenda
    }
    events.push({
      id: `maintenance:${s.scheduleId}`,
      kind: 'maintenance',
      title: `Maintenance — ${s.itemName}`,
      detail,
      dueAt,
      hasDate,
      target: { route: '/inventory', itemId: s.itemId },
    });
  }
  return events;
}

function buildWarrantyEvents(sources: readonly WarrantyAgendaSource[]): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    if (s.warrantyExpiresAt == null) continue;
    const dueAt = Date.parse(s.warrantyExpiresAt);
    if (!Number.isFinite(dueAt)) continue;
    events.push({
      id: `warranty:${s.id}:${s.warrantyExpiresAt}`,
      kind: 'warranty',
      title: `Warranty expiry — ${s.name}`,
      detail: `Warranty expires ${isoDate(dueAt)}.`,
      dueAt,
      hasDate: true,
      target: { route: '/inventory', itemId: s.id },
    });
  }
  return events;
}

function buildExpiryEvents(sources: readonly ExpiryAgendaSource[]): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    if (s.expiryDate == null) continue;
    events.push({
      id: `expiry:${s.id}`,
      kind: 'expiry',
      title: `Expiry — ${s.name}`,
      detail: `Expires ${isoDate(s.expiryDate)}.`,
      dueAt: s.expiryDate,
      hasDate: true,
      target: { route: '/inventory', itemId: s.id },
    });
  }
  return events;
}

function buildCheckoutEvents(sources: readonly CheckoutAgendaSource[]): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    if (s.dueDate == null) continue;
    events.push({
      id: `checkout-due:${s.id}`,
      kind: 'checkout-due',
      title: `Loan due back — ${s.itemName}`,
      detail: `On loan to ${s.contactName} — due ${isoDate(s.dueDate)}.`,
      dueAt: s.dueDate,
      hasDate: true,
      target: { route: '/inventory', itemId: s.itemId },
    });
  }
  return events;
}

function buildReorderEvents(sources: readonly ReorderAgendaSource[], now: number): AgendaEvent[] {
  return sources.map((s) => ({
    id: `reorder:${s.itemId}`,
    kind: 'reorder' as AgendaKind,
    title: `Reorder — ${s.itemName}`,
    detail:
      s.shortfall > 0
        ? `${s.shortfall} unit${s.shortfall === 1 ? '' : 's'} below the reorder point.`
        : 'At or below the reorder point.',
    dueAt: now,
    hasDate: false,
    target: { route: '/purchase-orders', itemId: s.itemId },
  }));
}

/**
 * Asset bookings (Phase 78). A booking is anchored at its `start_date` so an upcoming
 * reservation buckets by when it begins; a booking already under way (the window contains
 * `now`, inclusive of the whole end day) is anchored at `now` so it reads as "happening now"
 * (Today) rather than being pushed into Overdue by its past start. The hook only feeds active
 * (non-cancelled, non-converted) bookings whose window has not entirely passed.
 */
function buildBookingEvents(sources: readonly BookingAgendaSource[], now: number): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    const endExclusive = startOfLocalDay(s.endDate) + MS_PER_DAY;
    const active = s.startDate <= now && now < endExclusive;
    const forWhom = s.contactName ? ` for ${s.contactName}` : '';
    events.push({
      id: `booking:${s.id}`,
      kind: 'booking',
      title: `Booking — ${s.itemName}`,
      detail: active
        ? `Booked through ${isoDate(s.endDate)}${forWhom}.`
        : `Booked ${isoDate(s.startDate)} – ${isoDate(s.endDate)}${forWhom}.`,
      dueAt: active ? now : s.startDate,
      hasDate: !active,
      target: { route: '/bookings', itemId: s.itemId },
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// buildAgenda — flatten + sort
// ---------------------------------------------------------------------------

/**
 * Fold the five sources into a single `AgendaEvent[]`, soonest first.
 *
 * Sort: by `dueAt` ascending (overdue → far future), tie-broken by deterministic `id` so the
 * order is stable across renders. `now` is injected for the date-less lanes and testability.
 */
export function buildAgenda(sources: AgendaSources, now: number): AgendaEvent[] {
  const all: AgendaEvent[] = [
    ...buildMaintenanceEvents(sources.maintenance, now),
    ...buildWarrantyEvents(sources.warranty),
    ...buildExpiryEvents(sources.expiry),
    ...buildCheckoutEvents(sources.checkouts),
    ...buildReorderEvents(sources.reorder, now),
    ...buildBookingEvents(sources.bookings, now),
  ];
  return all.slice().sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Date bucketing
// ---------------------------------------------------------------------------

/** Display order of the agenda buckets. */
export const AGENDA_BUCKET_ORDER: readonly AgendaBucket[] = [
  'overdue',
  'today',
  'week',
  'month',
  'later',
];

/** Human-readable bucket headings. */
export const AGENDA_BUCKET_LABEL: Record<AgendaBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  month: 'This month',
  later: 'Later',
};

/**
 * Start of the local calendar day containing `now` (local midnight, UNIX-ms). Bucket
 * boundaries hang off this so "Today"/"This week"/"This month" align to calendar days rather
 * than rolling 24-hour windows. Pure given `now` and the host time zone; unit tests derive
 * their event instants from this same anchor so they hold in any time zone.
 */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Classify a single event into its chronological bucket relative to `now`:
 * - **overdue** — already in the past (`dueAt < now`).
 * - **today**   — the remainder of the current calendar day.
 * - **week**    — within the next 7 calendar days.
 * - **month**   — within the next 30 calendar days.
 * - **later**   — beyond 30 days (the catch-all).
 */
export function bucketForDueAt(dueAt: number, now: number): AgendaBucket {
  if (dueAt < now) return 'overdue';
  const startOfDay = startOfLocalDay(now);
  if (dueAt < startOfDay + MS_PER_DAY) return 'today';
  if (dueAt < startOfDay + 7 * MS_PER_DAY) return 'week';
  if (dueAt < startOfDay + 30 * MS_PER_DAY) return 'month';
  return 'later';
}

/** One non-empty bucket of agenda events, preserving the soonest-first input order. */
export interface AgendaSection {
  readonly bucket: AgendaBucket;
  readonly label: string;
  readonly events: AgendaEvent[];
}

/**
 * Group a (sorted) event list into the ordered, **non-empty** chronological sections. Empty
 * buckets are omitted so the UI renders only the headings that have content (matching the
 * alert centre). Input order is preserved within each bucket.
 */
export function bucketAgenda(events: readonly AgendaEvent[], now: number): AgendaSection[] {
  const byBucket = new Map<AgendaBucket, AgendaEvent[]>();
  for (const event of events) {
    const bucket = bucketForDueAt(event.dueAt, now);
    const existing = byBucket.get(bucket);
    if (existing) existing.push(event);
    else byBucket.set(bucket, [event]);
  }
  const sections: AgendaSection[] = [];
  for (const bucket of AGENDA_BUCKET_ORDER) {
    const bucketEvents = byBucket.get(bucket);
    if (bucketEvents && bucketEvents.length > 0) {
      sections.push({ bucket, label: AGENDA_BUCKET_LABEL[bucket], events: bucketEvents });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Kind filtering
// ---------------------------------------------------------------------------

/** Every agenda kind, for "all on by default" filter state and the filter control. */
export const AGENDA_KINDS: readonly AgendaKind[] = [
  'maintenance',
  'warranty',
  'expiry',
  'checkout-due',
  'reorder',
  'booking',
];

/** Keep only events whose kind is in `enabled`. An empty set yields no events. */
export function filterByKind(
  events: readonly AgendaEvent[],
  enabled: ReadonlySet<AgendaKind>,
): AgendaEvent[] {
  return events.filter((e) => enabled.has(e.kind));
}

// ---------------------------------------------------------------------------
// Maintenance source derivation (re-export the TIME helper for the hook)
// ---------------------------------------------------------------------------

/**
 * Derive a TIME schedule's due instant from its raw fields, re-exported from the alert centre
 * so the agenda hook computes it without reaching into the repository layer. Returns null for
 * USAGE schedules (which have no calendar due date — see {@link MaintenanceAgendaSource}).
 */
export { maintenanceDueAtMs };
