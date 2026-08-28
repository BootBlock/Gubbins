/**
 * Amend an open booking — who it is for, which days it covers, and its note (issue #659).
 *
 * A booking used to be immutable: once made, the card offered only Check out, Cancel and Delete.
 * That made two ordinary situations unrecoverable. A booking created with no contact — which the
 * form invites, "leave blank if you're only reserving the slot" — cannot be checked out, and
 * neither can one whose contact was later deleted (the column is `ON DELETE SET NULL`). The error
 * named the fix, "add a contact to the booking", and nothing in the UI could perform it, so the
 * only way out was to cancel and re-create, briefly releasing the reserved slot.
 *
 * Only the fields the user actually changed are sent, so leaving the contact alone re-uses the
 * stored id rather than re-resolving it by name. The repository re-checks the day range for
 * clashes, excluding this booking's own row.
 */
import { useRef, useState } from 'react';
import { Button, FormField, Input, Modal, useReportUnsavedChanges } from '@/components/foundry';
import type { AssetBookingWithNames, UpdateBookingInput } from '@/db/repositories';
import { fromDateInputValue, toDateInputValue } from '@/lib/date-input';
import { useErrorMessage } from '@/features/errors';
import { useT } from '@/features/i18n';
import { ContactNameField } from './ContactNameField';
import { useUpdateBooking } from './bookings';

export function BookingEditDialog({
  booking,
  open,
  onClose,
  onResult,
}: {
  booking: AssetBookingWithNames;
  open: boolean;
  onClose: () => void;
  onResult: (message: string, ok: boolean) => void;
}) {
  const t = useT();
  const update = useUpdateBooking();
  const describeError = useErrorMessage();
  const contactRef = useRef<HTMLInputElement>(null);

  const [contactName, setContactName] = useState(booking.contactName ?? '');
  const [start, setStart] = useState(() => toDateInputValue(booking.startDate));
  const [end, setEnd] = useState(() => toDateInputValue(booking.endDate));
  const [note, setNote] = useState(booking.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const startMs = fromDateInputValue(start);
  const endMs = fromDateInputValue(end);

  const contactChanged = contactName.trim() !== (booking.contactName ?? '');
  const startChanged = startMs !== booking.startDate;
  const endChanged = endMs !== booking.endDate;
  const noteChanged = note.trim() !== (booking.note ?? '');
  const dirty = contactChanged || startChanged || endChanged || noteChanged;

  useReportUnsavedChanges(dirty);

  const submit = () => {
    setError(null);
    if (startMs === null || endMs === null) {
      setError(t('bookings.edit.datesRequired'));
      return;
    }
    if (endMs < startMs) {
      setError(t('bookings.edit.rangeBackwards'));
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }

    const input: UpdateBookingInput = {
      ...(contactChanged ? { contactName: contactName.trim() || null } : {}),
      ...(startChanged ? { startDate: startMs } : {}),
      ...(endChanged ? { endDate: endMs } : {}),
      ...(noteChanged ? { note: note.trim() || null } : {}),
    };

    update.mutate(
      { id: booking.id, input },
      {
        onSuccess: () => {
          onResult(t('bookings.edit.saved'), true);
          onClose();
        },
        onError: (e) => {
          const message = describeError(e, t('bookings.edit.failed'));
          setError(message);
          onResult(message, false);
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('bookings.edit.title')}
      description={booking.itemName}
      initialFocusRef={contactRef}
      busy={update.isPending}
    >
      <div className="space-y-4">
        <ContactNameField
          ref={contactRef}
          label={t('bookings.edit.contactLabel')}
          hint={t('bookings.edit.contactHint')}
          value={contactName}
          onChange={setContactName}
          data-testid="booking-edit-contact"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('bookings.edit.fromLabel')} hint={t('bookings.edit.fromHint')}>
            <Input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              data-testid="booking-edit-start"
            />
          </FormField>
          <FormField label={t('bookings.edit.toLabel')} hint={t('bookings.edit.toHint')}>
            <Input
              type="date"
              value={end}
              min={start || undefined}
              onChange={(e) => setEnd(e.target.value)}
              data-testid="booking-edit-end"
            />
          </FormField>
        </div>

        <FormField label={t('bookings.edit.noteLabel')} hint={t('bookings.edit.noteHint')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} data-testid="booking-edit-note" />
        </FormField>

        {error ? (
          <p role="alert" className="text-sm text-destructive" data-testid="booking-edit-error">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            {t('bookings.edit.cancel')}
          </Button>
          <Button onClick={submit} disabled={update.isPending} data-testid="booking-edit-save">
            {t('bookings.edit.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
