/**
 * BookingsScreen — time-based asset booking / reservations (Phase 78, Wave 2 #2).
 *
 * Reserve a **specific** serialised / single-unit asset for a future whole-day date range
 * ("book the 3D printer Tue–Thu"), with double-booking hard-prevented in the repository via
 * the pure overlap seam. This is distinct from the §4 project *quantity* reservation (a stock
 * annotation) — a booking is a calendar hold on one identifiable unit. A booking can be
 * converted into a checkout (handing the asset over) or cancelled; both states are *derived*
 * from stored nullable columns (see `booking-status.ts`). Bookings also surface in the
 * Phase-75 `/upcoming` agenda as a sixth lane.
 *
 * Accessibility (§3 WCAG 4.1.3): an always-mounted `<LiveRegion>` announces the outcome of
 * each booking action (Phase 63 pattern). The screen carries `id={MAIN_CONTENT_ID}` for the
 * skip-to-content link (Phase 40).
 */
import { useState } from 'react';
import {
  Button,
  Input,
  LiveRegion,
  MAIN_CONTENT_ID,
  PageHeader,
  Select,
  Spinner,
  Surface,
} from '@/components/foundry';
import { BookingIcon, CheckoutIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useContacts } from '@/features/contacts/contacts';
import type { AssetBookingWithNames } from '@/db/repositories';
import {
  BOOKING_STATUS_BADGE,
  BOOKING_STATUS_LABEL,
  BOOKING_STATUSES,
  deriveBookingStatus,
  type BookingStatus,
} from './booking-status';
import {
  useBookableAssets,
  useBookings,
  useCancelBooking,
  useConvertBooking,
  useCreateBooking,
  useDeleteBooking,
} from './bookings';

/** Parse a yyyy-mm-dd input into a midday UNIX-ms instant (the repo snaps to the day start). */
function dayInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(`${value}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// New-booking form
// ---------------------------------------------------------------------------

function NewBookingForm({ onResult }: { onResult: (message: string, ok: boolean) => void }) {
  const assets = useBookableAssets();
  const contacts = useContacts();
  const create = useCreateBooking();

  const [itemId, setItemId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [contactName, setContactName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setItemId('');
    setStart('');
    setEnd('');
    setContactName('');
    setNote('');
  };

  const submit = () => {
    setError(null);
    const startMs = dayInputToMs(start);
    const endMs = dayInputToMs(end);
    if (!itemId) {
      setError('Choose an asset to book.');
      return;
    }
    if (startMs === null || endMs === null) {
      setError('Choose a start and end date.');
      return;
    }
    if (endMs < startMs) {
      setError('The end date cannot be before the start date.');
      return;
    }
    create.mutate(
      {
        itemId,
        startDate: startMs,
        endDate: endMs,
        contactName: contactName.trim() || null,
        note: note.trim() || null,
      },
      {
        onSuccess: () => {
          reset();
          onResult('Booking created.', true);
        },
        onError: (e) => {
          const message = e instanceof Error ? e.message : 'Could not create the booking.';
          setError(message);
          onResult(message, false);
        },
      },
    );
  };

  return (
    <Surface className="flex flex-col gap-4 p-4" data-testid="new-booking-form">
      <h2 className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4">
        <BookingIcon />
        New booking
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Asset</span>
          <Select
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            data-testid="booking-asset"
          >
            <option value="">Choose an asset…</option>
            {assets.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          {assets.data && assets.data.length === 0 ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              No bookable assets yet — only serialised or single-unit items can be booked.
            </span>
          ) : null}
        </label>

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Booked for (optional)</span>
          <Input
            list="booking-contact-suggestions"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="Type a name — new names are added automatically"
          />
          <datalist id="booking-contact-suggestions">
            {contacts.data?.rows.map((c) => <option key={c.id} value={c.name} />)}
          </datalist>
        </label>

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">From</span>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="booking-start" />
        </label>

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">To</span>
          <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} data-testid="booking-end" />
        </label>
      </div>

      <label className="block">
        <span className="mb-field-gap block text-sm font-medium">Note (optional)</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. for the trade-show build" />
      </label>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

      <div className="flex justify-end">
        <Button onClick={submit} disabled={create.isPending} data-testid="booking-submit">
          <BookingIcon />
          Book asset
        </Button>
      </div>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Booking card
// ---------------------------------------------------------------------------

function BookingCard({
  booking,
  status,
  onResult,
}: {
  booking: AssetBookingWithNames;
  status: BookingStatus;
  onResult: (message: string, ok: boolean) => void;
}) {
  const f = useFormatters();
  const cancel = useCancelBooking();
  const convert = useConvertBooking();
  const remove = useDeleteBooking();

  const isOpen = status === 'upcoming' || status === 'active' || status === 'overdue';
  const busy = cancel.isPending || convert.isPending || remove.isPending;

  /** Shared success/error reporter for a booking mutation. */
  const report = (okMessage: string, failMessage: string) => ({
    onSuccess: () => onResult(okMessage, true),
    onError: (e: unknown) => onResult(e instanceof Error ? e.message : failMessage, false),
  });

  return (
    <Surface className="flex flex-col gap-2 p-4" data-testid={`booking-card-${booking.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{booking.itemName}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${BOOKING_STATUS_BADGE[status]}`}
          data-testid={`booking-status-${booking.id}`}
        >
          {BOOKING_STATUS_LABEL[status]}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {f.date(booking.startDate)} – {f.date(booking.endDate)}
        {booking.contactName ? ` · for ${booking.contactName}` : ''}
      </p>
      {booking.note ? <p className="text-xs text-muted-foreground">{booking.note}</p> : null}

      <div className="mt-1 flex flex-wrap justify-end gap-2">
        {isOpen ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                convert.mutate(
                  { id: booking.id },
                  report('Booking checked out.', 'Could not check the booking out.'),
                )
              }
              data-testid={`booking-convert-${booking.id}`}
            >
              <CheckoutIcon />
              Check out
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                cancel.mutate(booking.id, report('Booking cancelled.', 'Could not cancel the booking.'))
              }
              data-testid={`booking-cancel-${booking.id}`}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              remove.mutate(booking.id, report('Booking removed.', 'Could not remove the booking.'))
            }
            data-testid={`booking-delete-${booking.id}`}
          >
            Delete
          </Button>
        )}
      </div>
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function BookingsScreen() {
  const { data, isLoading, isError } = useBookings();
  const [announcement, setAnnouncement] = useState('');
  const [announcementOk, setAnnouncementOk] = useState(true);

  const onResult = (message: string, ok: boolean) => {
    setAnnouncement(message);
    setAnnouncementOk(ok);
  };

  // A single wall-clock instant for this render, so every status in the list is derived
  // against the same `now` (mirrors the agenda's single-`now` discipline). The grouping is a
  // bounded (≤100-row) fold, so it is computed directly each render rather than memoised on a
  // per-render `now` (which would never hit the cache anyway).
  const now = Date.now();
  const bookings = data?.rows ?? [];

  const byStatus = new Map<BookingStatus, AssetBookingWithNames[]>();
  for (const booking of bookings) {
    const status = deriveBookingStatus(booking, now);
    const list = byStatus.get(status);
    if (list) list.push(booking);
    else byStatus.set(status, [booking]);
  }
  const groups = BOOKING_STATUSES.map((status) => ({
    status,
    rows: byStatus.get(status) ?? [],
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <PageHeader icon={<BookingIcon />} title="Bookings" />

      <NewBookingForm onResult={onResult} />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-col gap-6 outline-none" data-testid="bookings-main">
        {isLoading && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {isError && !isLoading && (
          <Surface className="p-6 text-center text-sm text-destructive">
            Failed to load bookings. Please refresh the page.
          </Surface>
        )}

        {!isLoading && !isError && bookings.length === 0 && (
          <Surface className="flex flex-col items-center gap-3 p-12 text-center">
            <BookingIcon className="size-10 text-muted-foreground" />
            <p className="font-medium">No bookings yet</p>
            <p className="text-sm text-muted-foreground">
              Reserve a serialised or single-unit asset for a date range using the form above.
            </p>
          </Surface>
        )}

        {!isLoading && !isError && groups.length > 0 && (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section key={group.status} aria-labelledby={`bookings-section-${group.status}`}>
                <h2
                  id={`bookings-section-${group.status}`}
                  className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {BOOKING_STATUS_LABEL[group.status]}
                  <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {group.rows.length}
                  </span>
                </h2>
                <div className="flex flex-col gap-3">
                  {group.rows.map((booking) => (
                    <BookingCard
                      key={booking.id}
                      booking={booking}
                      status={group.status}
                      onResult={onResult}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {/* Always-mounted live regions (WCAG 4.1.3) — announce each booking-action outcome. */}
      <LiveRegion visuallyHidden data-testid="bookings-live-region">
        {announcementOk && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="bookings-error-live-region">
        {!announcementOk && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </div>
  );
}
