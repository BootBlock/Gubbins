/**
 * Unified "Upcoming" agenda pure seam (Phase 75, third feature-gap audit candidate #1).
 *
 * Folds every date-driven event in the app — maintenance due (time + usage), warranty
 * expiry, perishable expiry, checkout due-back, reorder-now, bookings and opted-in
 * custom-field due dates (W1a) — into ONE chronological,
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
import { addCalendarDays, startOfLocalDay, startOfUtcDay, utcDayToLocalDay } from '@/lib/calendar-days';
import { plural } from '@/lib/plural';
import { daysOverdue, overdueLabel } from '@/features/contacts/overdue';
import { maintenanceDueAtMs } from '@/features/alerts/alerts';

// Re-exported so callers and this seam's tests keep importing `startOfLocalDay` from here while
// the definition lives in one shared place (issue #325).
export { startOfLocalDay };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The seven date-driven event categories the agenda aggregates. */
export type AgendaKind =
  'maintenance' | 'warranty' | 'expiry' | 'checkout-due' | 'reorder' | 'booking' | 'field-due';

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
  /** Who/what the loan is out to (B4): a contact, project or location name. */
  readonly borrowerName: string;
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

/**
 * An item's value for a custom `DATE` field its definition opted in as a **due date** (W1a).
 *
 * Unlike the alert-centre twin this lane carries no lead time: the agenda is the forward
 * calendar, so a date is worth showing from the moment it is recorded — the lead time decides
 * when it becomes an *alert*, not when it exists.
 */
export interface FieldDueAgendaSource {
  readonly itemId: string;
  readonly itemName: string;
  /** The dictionary definition id; part of the event id, since one item can have several. */
  readonly defId: string;
  /** The field's name as the user sees it on the item ("Renewal date"). */
  readonly fieldName: string;
  /** UNIX-ms midnight-UTC instant of the stored day. */
  readonly dueAt: number;
}

/** The seven pre-fetched source arrays passed to {@link buildAgenda}. */
export interface AgendaSources {
  readonly maintenance: readonly MaintenanceAgendaSource[];
  readonly warranty: readonly WarrantyAgendaSource[];
  readonly expiry: readonly ExpiryAgendaSource[];
  readonly checkouts: readonly CheckoutAgendaSource[];
  readonly reorder: readonly ReorderAgendaSource[];
  readonly bookings: readonly BookingAgendaSource[];
  readonly fieldDue: readonly FieldDueAgendaSource[];
}

// ---------------------------------------------------------------------------
// Formatting seam
// ---------------------------------------------------------------------------

/**
 * Renders a UNIX-ms instant as a human-readable date for the agenda's detail copy. Injected
 * (rather than sliced from an ISO string here) so every date in the agenda reads exactly as the
 * same field does elsewhere in the app — the shared `useFormatters().date` seam, in the user's
 * locale — instead of a UTC-sliced `YYYY-MM-DD` that can even land on the wrong day. Kept a pure
 * parameter so the seam stays free of React/preferences and remains exhaustively unit-testable.
 */
export type AgendaDateFormatter = (ms: number) => string;

// ---------------------------------------------------------------------------
// Lane builders (pure; each emits zero or one event per source row)
// ---------------------------------------------------------------------------

function buildMaintenanceEvents(
  sources: readonly MaintenanceAgendaSource[],
  now: number,
  formatDate: AgendaDateFormatter,
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
      detail = `Schedule "${s.scheduleName}" — due ${formatDate(s.dueAtMs)}.`;
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

function buildWarrantyEvents(
  sources: readonly WarrantyAgendaSource[],
  formatDate: AgendaDateFormatter,
): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    if (s.warrantyExpiresAt == null) continue;
    const dueAt = Date.parse(s.warrantyExpiresAt);
    if (!Number.isFinite(dueAt)) continue;
    events.push({
      id: `warranty:${s.id}:${s.warrantyExpiresAt}`,
      kind: 'warranty',
      title: `Warranty expiry — ${s.name}`,
      detail: `Warranty expires ${formatDate(dueAt)}.`,
      dueAt,
      hasDate: true,
      target: { route: '/inventory', itemId: s.id },
    });
  }
  return events;
}

function buildExpiryEvents(
  sources: readonly ExpiryAgendaSource[],
  formatDate: AgendaDateFormatter,
): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    if (s.expiryDate == null) continue;
    events.push({
      id: `expiry:${s.id}`,
      kind: 'expiry',
      title: `Expiry — ${s.name}`,
      detail: `Expires ${formatDate(s.expiryDate)}.`,
      dueAt: s.expiryDate,
      hasDate: true,
      target: { route: '/inventory', itemId: s.id },
    });
  }
  return events;
}

function buildCheckoutEvents(
  sources: readonly CheckoutAgendaSource[],
  now: number,
  formatDate: AgendaDateFormatter,
): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    if (s.dueDate == null) continue;
    // A late loan reads its shortfall the same way low stock does: the overdue span is spelled
    // out ("N days overdue") ahead of the raw date. The affordance keys off the same calendar-day
    // boundary the agenda buckets on (issue #322) — a loan counts as overdue only once its due
    // *day* has fully passed — so a loan due today sits in "Today" reading plainly, never under the
    // "Today" heading tagged "Overdue". `daysOverdue` still measures the real elapsed span for the
    // "N days overdue" copy, and the event still anchors at the real `dueDate` so an already-passed
    // loan sorts to the top of the chronological view.
    const overdue = s.dueDate < startOfLocalDay(now);
    const detail = overdue
      ? `On loan to ${s.borrowerName} — ${overdueLabel(daysOverdue(s.dueDate, now))} (due ${formatDate(s.dueDate)}).`
      : `On loan to ${s.borrowerName} — due ${formatDate(s.dueDate)}.`;
    events.push({
      id: `checkout-due:${s.id}`,
      kind: 'checkout-due',
      title: `Loan due back — ${s.itemName}`,
      detail,
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
    kind: 'reorder',
    title: `Reorder — ${s.itemName}`,
    detail:
      s.shortfall > 0
        ? `${s.shortfall} ${plural(s.shortfall, 'unit')} below the reorder point.`
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
function buildBookingEvents(
  sources: readonly BookingAgendaSource[],
  now: number,
  formatDate: AgendaDateFormatter,
): AgendaEvent[] {
  const events: AgendaEvent[] = [];
  for (const s of sources) {
    // Booking `endDate` is a midnight-UTC day-start (issue #320); a UTC day is exactly MS_PER_DAY,
    // so the next UTC midnight is `+ MS_PER_DAY` (no DST wrinkle) — close the window there so
    // "active" (window contains `now`) is not off by a day west of UTC.
    const endExclusive = startOfUtcDay(s.endDate) + MS_PER_DAY;
    const active = s.startDate <= now && now < endExclusive;
    const forWhom = s.contactName ? ` for ${s.contactName}` : '';
    events.push({
      id: `booking:${s.id}`,
      kind: 'booking',
      title: `Booking — ${s.itemName}`,
      detail: active
        ? `Booked through ${formatDate(s.endDate)}${forWhom}.`
        : `Booked ${formatDate(s.startDate)} – ${formatDate(s.endDate)}${forWhom}.`,
      dueAt: active ? now : s.startDate,
      hasDate: !active,
      target: { route: '/bookings', itemId: s.itemId },
    });
  }
  return events;
}

/**
 * Opted-in custom-field due dates (W1a) — a user-defined "Renewal date" or "Inspection due"
 * taking its place on the calendar beside the built-in deadlines.
 *
 * The field is named in the title rather than the detail because it *is* the event: two items
 * can carry three dated fields between them, and "Renewal date — Studio insurance" says which
 * one at a glance where a generic "Custom field — …" would not.
 *
 * The stored day is re-anchored onto the local calendar with `utcDayToLocalDay` (issue #323)
 * before it becomes the event's `dueAt`. Everything downstream reads that instant in **local**
 * terms — {@link bucketForDueAt} compares it against `startOfLocalDay`, and the card renders it
 * through the locale date formatter — while the value itself is a midnight-**UTC** stamp (issue
 * #320). Passed through raw, a date of "20 July" is 19 July 20:00 in New York, so it would
 * bucket as Overdue and *display* as the 19th all through the 20th — and contradict the alert
 * centre, which grades the very same row as due-soon via `fieldDueStatus`. Re-anchoring is what
 * keeps the two surfaces agreeing about one date.
 */
function buildFieldDueEvents(
  sources: readonly FieldDueAgendaSource[],
  formatDate: AgendaDateFormatter,
): AgendaEvent[] {
  return sources.map((s) => {
    const dueAt = utcDayToLocalDay(s.dueAt);
    return {
      id: `field-due:${s.itemId}:${s.defId}`,
      kind: 'field-due',
      title: `${s.fieldName} — ${s.itemName}`,
      detail: `Due ${formatDate(dueAt)}.`,
      dueAt,
      hasDate: true,
      target: { route: '/inventory', itemId: s.itemId },
    };
  });
}

// ---------------------------------------------------------------------------
// buildAgenda — flatten + sort
// ---------------------------------------------------------------------------

/**
 * Fold the seven sources into a single `AgendaEvent[]`, soonest first.
 *
 * Sort: by `dueAt` ascending (overdue → far future), tie-broken by deterministic `id` so the
 * order is stable across renders. `now` is injected for the date-less lanes and testability;
 * `formatDate` renders every date in the detail copy through the shared formatter seam (issue
 * #328) so the agenda matches the date shown for the same field elsewhere in the app.
 */
export function buildAgenda(
  sources: AgendaSources,
  now: number,
  formatDate: AgendaDateFormatter,
): AgendaEvent[] {
  const all: AgendaEvent[] = [
    ...buildMaintenanceEvents(sources.maintenance, now, formatDate),
    ...buildWarrantyEvents(sources.warranty, formatDate),
    ...buildExpiryEvents(sources.expiry, formatDate),
    ...buildCheckoutEvents(sources.checkouts, now, formatDate),
    ...buildReorderEvents(sources.reorder, now),
    ...buildBookingEvents(sources.bookings, now, formatDate),
    ...buildFieldDueEvents(sources.fieldDue, formatDate),
  ];
  return all.slice().sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Date bucketing
// ---------------------------------------------------------------------------

/**
 * Display order of the agenda buckets.
 *
 * @internal Exported for unit tests only.
 */
export const AGENDA_BUCKET_ORDER: readonly AgendaBucket[] = ['overdue', 'today', 'week', 'month', 'later'];

/** Human-readable bucket headings. */
export const AGENDA_BUCKET_LABEL: Record<AgendaBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  month: 'This month',
  later: 'Later',
};

/**
 * Classify a single event into its chronological bucket relative to `now`:
 * - **overdue** — before the start of today's local calendar day.
 * - **today**   — anywhere within the current calendar day (including earlier today).
 * - **week**    — within the next 7 calendar days.
 * - **month**   — within the next 30 calendar days.
 * - **later**   — beyond 30 days (the catch-all).
 *
 * Every boundary hangs off {@link startOfLocalDay}, not the raw `now` instant, so bucketing is
 * calendar-day-aligned rather than a rolling clock. That is what keeps a same-day event in
 * "Today": warranty and expiry dates are anchored at UTC midnight, so an event due *today* is
 * already earlier than `now` from the start of the working day onward — testing `dueAt < now`
 * (rather than `dueAt < startOfLocalDay(now)`) would sweep every one of them into "Overdue" and
 * leave "Today" reachable only by the date-less reorder/usage entries (issue #322).
 *
 * The forward edges step with {@link addCalendarDays} rather than a fixed 24-hour span, so the
 * "next 7 days" boundary stays at local midnight even across a DST change, not an hour adrift
 * (issue #325).
 */
export function bucketForDueAt(dueAt: number, now: number): AgendaBucket {
  const startOfDay = startOfLocalDay(now);
  if (dueAt < startOfDay) return 'overdue';
  if (dueAt < addCalendarDays(startOfDay, 1)) return 'today';
  if (dueAt < addCalendarDays(startOfDay, 7)) return 'week';
  if (dueAt < addCalendarDays(startOfDay, 30)) return 'month';
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
export const AGENDA_KINDS = [
  'maintenance',
  'warranty',
  'expiry',
  'checkout-due',
  'reorder',
  'booking',
  'field-due',
] as const satisfies readonly AgendaKind[];

/**
 * Compile-time **completeness** guard for {@link AGENDA_KINDS}, matching the one over
 * `REMINDER_KINDS`. Without it a lane left out of the array compiles cleanly and then silently
 * has no filter chip and is switched off by nothing, since the screen seeds its filter state
 * from this list.
 *
 * Note the declaration above must stay `as const satisfies …` rather than carrying a
 * `: readonly AgendaKind[]` annotation. An annotation widens `typeof AGENDA_KINDS` back to
 * `readonly AgendaKind[]`, so `(typeof AGENDA_KINDS)[number]` becomes `AgendaKind`, the
 * `Exclude` below is unconditionally `never`, and this guard silently cannot fail.
 */
type AgendaKindsAreExhaustive =
  Exclude<AgendaKind, (typeof AGENDA_KINDS)[number]> extends never
    ? true
    : ['Add this lane to AGENDA_KINDS:', Exclude<AgendaKind, (typeof AGENDA_KINDS)[number]>];
const agendaKindsAreExhaustive: AgendaKindsAreExhaustive = true;
void agendaKindsAreExhaustive;

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
