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
  FormField,
  Input,
  LiveRegion,
  MAIN_CONTENT_ID,
  PageContainer,
  PageHeader,
  SelectField,
  Spinner,
  Surface,
} from '@/components/foundry';
import { BookingIcon, CheckoutIcon, EditIcon, InfoIcon, SuccessIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { nowMs } from '@/lib/clock';
import { fromDateInputValue } from '@/lib/date-input';
import type { AssetBookingWithNames } from '@/db/repositories';
import { useErrorMessage } from '@/features/errors';
import { useT } from '@/features/i18n';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { exportEveryPage } from '@/features/export/export-every-page';
import { bookingsExportFilename, buildBookingsExport } from './bookings-export';
import { BookingCheckoutDialog } from './BookingCheckoutDialog';
import { BookingEditDialog } from './BookingEditDialog';
import { ContactNameField } from './ContactNameField';
import {
  BOOKING_STATUS_BADGE,
  BOOKING_STATUS_LABEL,
  BOOKING_STATUSES,
  deriveBookingStatus,
  type BookingStatus,
} from './booking-status';
import {
  readBookingsPage,
  useBookableAssets,
  useBookings,
  useCancelBooking,
  useConvertBooking,
  useCreateBooking,
  useDeleteBooking,
} from './bookings';

/**
 * Turn a bookings-load failure into a concrete reason plus actionable guidance.
 *
 * The list is read from the local database, so a load failure is almost always a
 * local-storage / database problem (a blocked or evicted OPFS store, a migration that
 * couldn't open, or private-browsing restrictions) rather than a network outage. We surface
 * the underlying error verbatim so the cause is visible, and pair it with the most likely
 * fix instead of a bare "please refresh".
 */
function describeBookingsLoadError(error: unknown): { reason: string; guidance: string } {
  const reason =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'The bookings could not be read from the local database.';

  const lower = reason.toLowerCase();
  let guidance =
    'This usually means the local database could not be opened. Try again — if it keeps ' +
    'failing, close any other tabs running Gubbins (only one can hold the database at a time), ' +
    'then reload. As a last resort, restart your browser.';

  if (lower.includes('quota') || lower.includes('storage') || lower.includes('space')) {
    guidance =
      'Your browser is out of storage space for this site. Free up disk space (or clear other ' +
      'sites’ data), then try again. Your existing data is safe.';
  } else if (lower.includes('private') || lower.includes('security') || lower.includes('denied')) {
    guidance =
      'Your browser is blocking local storage — this often happens in private/incognito windows. ' +
      'Open Gubbins in a normal window and allow site data for this app, then try again.';
  } else if (lower.includes('migrat') || lower.includes('schema') || lower.includes('version')) {
    guidance =
      'The database is mid-upgrade or its schema doesn’t match this version of the app. Make sure ' +
      'every Gubbins tab is on the same version, close the others, then reload to finish the upgrade.';
  }

  return { reason, guidance };
}

// ---------------------------------------------------------------------------
// New-booking form
// ---------------------------------------------------------------------------

function NewBookingForm({ onResult }: { onResult: (message: string, ok: boolean) => void }) {
  const t = useT();
  const assets = useBookableAssets();
  const create = useCreateBooking();

  const [itemId, setItemId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [contactName, setContactName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  const reset = () => {
    setItemId('');
    setStart('');
    setEnd('');
    setContactName('');
    setNote('');
  };

  const submit = () => {
    setError(null);
    const startMs = fromDateInputValue(start);
    const endMs = fromDateInputValue(end);
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
          const message = describeError(e, 'Could not create the booking.');
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
        <div>
          <SelectField
            label="Asset"
            data-testid="booking-asset"
            value={itemId}
            onChange={setItemId}
            hintSize="md"
            hint={
              'Only **serialised** or **single-unit** assets can be booked — a specific, ' +
              'identifiable unit (e.g. *the* 3D printer), not bulk stock.\n\n' +
              'Items tracked by quantity don’t appear here; reserve those against a **project** instead.'
            }
            options={[
              { value: '', label: 'Choose an asset…' },
              ...(assets.data?.map((a) => ({ value: a.id, label: a.name })) ?? []),
            ]}
          />
          {assets.data && assets.data.length === 0 ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              No bookable assets yet — only serialised or single-unit items can be booked.
            </span>
          ) : null}
        </div>

        <ContactNameField
          label={t('bookings.form.contactLabel')}
          hint={t('bookings.form.contactHint')}
          value={contactName}
          onChange={setContactName}
          data-testid="booking-contact"
        />

        <FormField
          label="From"
          hint={
            'The **first day** of the reservation. Bookings are whole-day holds, so the asset is ' +
            'reserved from the start of this day.'
          }
        >
          <Input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            data-testid="booking-start"
          />
        </FormField>

        <FormField
          label="To"
          hint={
            'The **last day** of the reservation, inclusive — must be on or after **From**. The asset ' +
            'stays reserved through the end of this day.'
          }
        >
          <Input
            type="date"
            value={end}
            min={start || undefined}
            onChange={(e) => setEnd(e.target.value)}
            data-testid="booking-end"
          />
        </FormField>
      </div>

      <FormField
        label="Note (optional)"
        hint={
          'An optional reminder of **why** the asset is booked (e.g. a job, an event or a location). ' +
          'Shown on the booking card so it’s easy to tell reservations apart.'
        }
      >
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. for the trade-show build"
        />
      </FormField>

      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
  const t = useT();
  const f = useFormatters();
  const cancel = useCancelBooking();
  const convert = useConvertBooking();
  const remove = useDeleteBooking();
  const describeError = useErrorMessage();
  const [editing, setEditing] = useState(false);
  const [namingBorrower, setNamingBorrower] = useState(false);

  const isOpen = status === 'upcoming' || status === 'active' || status === 'overdue';
  const busy = cancel.isPending || convert.isPending || remove.isPending;
  /*
   * A booking need not name anyone: the form invites a blank contact for a slot-only
   * reservation, and `contact_id` is ON DELETE SET NULL, so deleting a contact clears it from
   * their future bookings too. Converting needs a borrower, so rather than let the button fail
   * with an instruction nothing could carry out, it asks for one first (issue #659).
   */
  const needsBorrower = booking.contactId === null;

  /** Shared success/error reporter for a booking mutation. */
  const report = (okMessage: string, failMessage: string) => ({
    onSuccess: () => onResult(okMessage, true),
    onError: (e: unknown) => onResult(describeError(e, failMessage), false),
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
        {f.calendarDate(booking.startDate)} – {f.calendarDate(booking.endDate)}
        {booking.contactName
          ? ` · for ${booking.contactName}`
          : isOpen
            ? ` · ${t('bookings.card.noContact')}`
            : ''}
      </p>
      {booking.note ? <p className="text-xs text-muted-foreground">{booking.note}</p> : null}

      <div className="mt-1 flex flex-wrap justify-end gap-2">
        {isOpen ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (needsBorrower) {
                  setNamingBorrower(true);
                  return;
                }
                convert.mutate(
                  { id: booking.id },
                  report('Booking checked out.', 'Could not check the booking out.'),
                );
              }}
              data-testid={`booking-convert-${booking.id}`}
            >
              <CheckoutIcon />
              Check out
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(true)}
              data-testid={`booking-edit-${booking.id}`}
            >
              <EditIcon />
              {t('bookings.card.edit')}
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

      {editing ? (
        <BookingEditDialog booking={booking} open onClose={() => setEditing(false)} onResult={onResult} />
      ) : null}
      {namingBorrower ? (
        <BookingCheckoutDialog
          booking={booking}
          open
          onClose={() => setNamingBorrower(false)}
          onResult={onResult}
        />
      ) : null}
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function BookingsScreen() {
  const t = useT();
  const { data, isLoading, isError, error, refetch, isFetching } = useBookings();
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
  const now = nowMs();
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
    <PageContainer>
      <PageHeader
        icon={<BookingIcon />}
        title="Bookings"
        actions={
          /*
           * The export re-reads every page rather than serialising the rows on screen — the
           * screen's read is capped at one page (which is why it carries a truncation notice),
           * so the file would stop at the same bound while looking complete. Statuses are
           * derived against this render's single `now`, so they agree with the headings above.
           */
          <TabularExportMenu
            build={(format) =>
              exportEveryPage(
                readBookingsPage,
                (rows) => buildBookingsExport(format, rows, now),
                t('export.list.truncated'),
              )
            }
            filename={bookingsExportFilename}
            triggerLabel={t('export.list.trigger')}
            menuLabel={t('export.bookings.menuLabel')}
            toastHeading={t('export.bookings.toast')}
            disabled={isLoading || bookings.length === 0}
            testIdPrefix="export-bookings"
          />
        }
      />

      <NewBookingForm onResult={onResult} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-col gap-6 outline-none"
        data-testid="bookings-main"
      >
        {isLoading && (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        )}

        {isError && !isLoading && (
          <Surface className="flex flex-col gap-3 p-6" data-testid="bookings-load-error">
            <p className="text-sm font-medium text-destructive">Couldn’t load your bookings</p>
            <p className="text-sm text-destructive" data-testid="bookings-load-error-reason">
              {describeBookingsLoadError(error).reason}
            </p>
            <p className="text-sm text-muted-foreground">{describeBookingsLoadError(error).guidance}</p>
            <div className="flex justify-start">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isFetching}
                data-testid="bookings-load-retry"
              >
                Try again
              </Button>
            </div>
          </Surface>
        )}

        {!isLoading && !isError && bookings.length === 0 && (
          <Surface className="flex flex-col items-center gap-4 p-8 text-center sm:p-12">
            <BookingIcon className="size-10 text-muted-foreground" aria-hidden />
            <p className="font-medium">No bookings yet</p>

            <div className="flex max-w-prose flex-col gap-3 text-left text-sm text-muted-foreground">
              <p>
                A <span className="font-medium text-foreground">booking</span> reserves one specific asset — a
                serialised or single-unit item such as the 3D printer or a particular camera — for a whole-day
                date range. It’s a calendar hold on that one unit, not a change to your stock: while it’s
                booked, nobody else can reserve the same unit for overlapping dates, so there’s no
                double-booking. When the day comes, turn the booking into a checkout to hand the asset over.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <SuccessIcon className="size-4 text-glyph-success" aria-hidden />
                    Reach for a booking when
                  </span>
                  <span>
                    you want to promise a shared, one-of-a-kind piece of equipment to someone ahead of time —
                    planning around a shoot, an event, or a loan.
                  </span>
                </div>
                <div className="flex flex-col gap-1 sm:text-right">
                  <span className="flex items-center gap-1.5 font-medium text-foreground sm:flex-row-reverse">
                    <InfoIcon className="size-4 text-glyph-neutral" aria-hidden />
                    You can skip it when
                  </span>
                  <span>
                    you’re dealing with everyday consumables or bulk stock (screws, cable, filament). For
                    those, reserve a quantity against a project or simply check items out.
                  </span>
                </div>
              </div>

              <p>Ready to start? Reserve an asset using the form above.</p>
            </div>
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

        {/* The read is bounded (§2.1). This list is grouped by derived status with a count on
            each heading, so a pager would slice those groups and misstate every badge — say the
            list is cut short instead of implying it is all of it (issue #149). Sits at the foot
            of the list, where every other truncation notice in the app does. */}
        {!isLoading && !isError && data?.hasMore ? (
          <p className="text-xs text-muted-foreground" data-testid="bookings-truncated">
            {t('bookings.list.truncated', { vars: { shown: bookings.length } })}
          </p>
        ) : null}
      </main>

      {/* Always-mounted live regions (WCAG 4.1.3) — announce each booking-action outcome. */}
      <LiveRegion visuallyHidden data-testid="bookings-live-region">
        {announcementOk && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
      <LiveRegion urgency="assertive" visuallyHidden data-testid="bookings-error-live-region">
        {!announcementOk && announcement ? <p>{announcement}</p> : null}
      </LiveRegion>
    </PageContainer>
  );
}
