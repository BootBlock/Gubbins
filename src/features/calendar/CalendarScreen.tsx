/**
 * CalendarScreen — the unified "Upcoming" agenda (Phase 75, third feature-gap audit #1).
 *
 * One chronological, time-ordered view of every date-driven event in the app: maintenance due
 * (time + usage), warranty expiry, perishable expiry, checkout due-back and reorder-now. These
 * previously lived scattered across the alert centre and dashboard widgets; this composes the
 * same existing queries into date buckets — Overdue / Today / This week / This month / Later —
 * each event tagged by kind with a jump-to-source link. Read-only; no schema change.
 *
 * Accessibility (§3 WCAG 4.1.3): an always-mounted `<LiveRegion>` announces the pending count
 * once data loads (Phase 63 pattern). The screen carries `id={MAIN_CONTENT_ID}` for the
 * skip-to-content link (Phase 40).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  LiveRegion,
  PageHeader,
  Spinner,
  Surface,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import {
  BookingIcon,
  CheckoutIcon,
  DueDateIcon,
  ExpiryIcon,
  LowStockIcon,
  MaintenanceIcon,
  NotificationIcon,
} from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import {
  AGENDA_KINDS,
  bucketAgenda,
  filterByKind,
  type AgendaBucket,
  type AgendaEvent,
  type AgendaKind,
} from './agenda';
import { useAgenda } from './useAgenda';

// ---------------------------------------------------------------------------
// Kind metadata — labels & icons
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<AgendaKind, string> = {
  maintenance: 'Maintenance',
  warranty: 'Warranty',
  expiry: 'Expiry',
  'checkout-due': 'Loans due',
  reorder: 'Reorder',
  booking: 'Bookings',
};

function KindIcon({ kind }: { kind: AgendaKind }) {
  switch (kind) {
    case 'maintenance': return <MaintenanceIcon aria-hidden />;
    case 'warranty': return <NotificationIcon aria-hidden />;
    case 'expiry': return <ExpiryIcon aria-hidden />;
    case 'checkout-due': return <CheckoutIcon aria-hidden />;
    case 'reorder': return <LowStockIcon aria-hidden />;
    case 'booking': return <BookingIcon aria-hidden />;
  }
}

// ---------------------------------------------------------------------------
// Bucket → accent tone (design tokens only — no raw colour literals)
// ---------------------------------------------------------------------------

/** Bucket accent classes: overdue → destructive, today → warning, the rest neutral. */
const BUCKET_TONE: Record<AgendaBucket, string> = {
  overdue: 'text-destructive',
  today: 'text-warning',
  week: 'text-muted-foreground',
  month: 'text-muted-foreground',
  later: 'text-muted-foreground',
};

const BUCKET_BADGE: Record<AgendaBucket, string> = {
  overdue: 'bg-destructive/10 text-destructive',
  today: 'bg-warning/10 text-warning-foreground',
  week: 'bg-muted text-muted-foreground',
  month: 'bg-muted text-muted-foreground',
  later: 'bg-muted text-muted-foreground',
};

// ---------------------------------------------------------------------------
// Event card
// ---------------------------------------------------------------------------

function EventCard({ event, bucket }: { event: AgendaEvent; bucket: AgendaBucket }) {
  const f = useFormatters();
  return (
    <Surface className="flex flex-col gap-2 p-4" data-testid={`agenda-card-${event.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className={`flex min-w-0 items-center gap-2 [&_svg]:size-4 ${BUCKET_TONE[bucket]}`}>
          <KindIcon kind={event.kind} />
          <span className="truncate text-sm font-medium text-foreground">{event.title}</span>
        </div>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${BUCKET_BADGE[bucket]}`}
        >
          {event.hasDate ? f.date(event.dueAt) : 'Now'}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{event.detail}</p>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Link
        to={event.target.route as any}
        className="self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
        data-testid={`agenda-link-${event.id}`}
      >
        {event.target.route === '/purchase-orders'
          ? 'View purchase orders'
          : event.target.route === '/bookings'
            ? 'View bookings'
            : 'View item'}
      </Link>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Kind filter — a token-styled toggle row
// ---------------------------------------------------------------------------

function KindFilter({
  enabled,
  onToggle,
}: {
  enabled: ReadonlySet<AgendaKind>;
  onToggle: (kind: AgendaKind) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-lg bg-secondary/60 p-0.5"
      role="group"
      aria-label="Filter by kind"
    >
      {AGENDA_KINDS.map((kind) => {
        const active = enabled.has(kind);
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onToggle(kind)}
            aria-pressed={active}
            data-testid={`agenda-filter-${kind}`}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors [&_svg]:size-3.5 ${
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <KindIcon kind={kind} />
            {KIND_LABEL[kind]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function CalendarScreen() {
  const { events, now, isLoading, isError } = useAgenda();

  // All kinds enabled by default; toggling a chip filters the agenda.
  const [enabledKinds, setEnabledKinds] = useState<Set<AgendaKind>>(() => new Set(AGENDA_KINDS));
  const toggleKind = (kind: AgendaKind) =>
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  // Bucket against the SAME `now` the hook anchored date-less events at — a second
  // `Date.now()` here would read marginally later and push reorder-now / due-USAGE events
  // (anchored at exactly `now`) into "Overdue" instead of "Today".
  const visible = useMemo(() => filterByKind(events, enabledKinds), [events, enabledKinds]);
  const sections = useMemo(() => bucketAgenda(visible, now), [visible, now]);

  // Announce the pending count once loading completes (WCAG 4.1.3), once only.
  const [announcement, setAnnouncement] = useState('');
  const announcedRef = useRef(false);
  useEffect(() => {
    if (isLoading || announcedRef.current) return;
    announcedRef.current = true;
    if (isError) {
      setAnnouncement('Upcoming items failed to load.');
    } else {
      const count = events.length;
      setAnnouncement(
        count === 0
          ? 'Nothing upcoming — all clear.'
          : `${count} upcoming item${count === 1 ? '' : 's'}.`,
      );
    }
  }, [isLoading, isError, events.length]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6">
      {/* Header ---------------------------------------------------------- */}
      <PageHeader icon={<DueDateIcon />} title="Upcoming" />

      {/* Kind filter ----------------------------------------------------- */}
      {!isLoading && !isError && events.length > 0 && (
        <KindFilter enabled={enabledKinds} onToggle={toggleKind} />
      )}

      {/* Main content ---------------------------------------------------- */}
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-col gap-6 outline-none"
        data-testid="agenda-main"
      >
        {isLoading && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {isError && !isLoading && (
          <Surface className="p-6 text-center text-sm text-destructive">
            Failed to load the agenda. Please refresh the page.
          </Surface>
        )}

        {!isLoading && !isError && events.length === 0 && (
          <Surface className="flex flex-col items-center gap-3 p-12 text-center">
            <DueDateIcon className="size-10 text-muted-foreground" />
            <p className="font-medium">Nothing upcoming</p>
            <p className="text-sm text-muted-foreground">
              No maintenance, warranties, expiries, loans, reorders or bookings are pending.
              You're all caught up.
            </p>
          </Surface>
        )}

        {!isLoading && !isError && events.length > 0 && sections.length === 0 && (
          <Surface className="p-6 text-center text-sm text-muted-foreground">
            No items match the selected kinds.
          </Surface>
        )}

        {!isLoading && !isError && sections.length > 0 && (
          <div className="flex flex-col gap-6">
            {sections.map((section) => (
              <section key={section.bucket} aria-labelledby={`agenda-section-${section.bucket}`}>
                <h2
                  id={`agenda-section-${section.bucket}`}
                  className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {section.label}
                  <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {section.events.length}
                  </span>
                </h2>
                <div className="flex flex-col gap-3">
                  {section.events.map((event) => (
                    <EventCard key={event.id} event={event} bucket={section.bucket} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {/* Always-mounted live regions (WCAG 4.1.3) — announce the pending count. */}
      <LiveRegion visuallyHidden data-testid="agenda-live-region">
        {!isError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="agenda-error-live-region">
        {isError && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </div>
  );
}
