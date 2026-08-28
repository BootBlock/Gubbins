/**
 * Ask who a contactless booking is going out to, then check it out (issue #659).
 *
 * `convertToCheckout` needs a borrower, and a booking is allowed to carry none — the form invites
 * a blank contact for a slot-only reservation, and deleting a contact strips it from their future
 * bookings. Pressing **Check out** on such a booking used to fail with "add a contact to the
 * booking before checking it out", an instruction the UI gave no way to follow. The conversion
 * already accepts a borrower, so this asks for one at the moment it is needed rather than making
 * the user go and edit the booking first (which {@link BookingEditDialog} still allows).
 *
 * A booking that *does* name someone never sees this — it converts on the single tap it always did.
 */
import { useRef, useState } from 'react';
import { Button, Modal, useReportUnsavedChanges } from '@/components/foundry';
import { CheckoutIcon } from '@/components/icons';
import type { AssetBookingWithNames } from '@/db/repositories';
import { useErrorMessage } from '@/features/errors';
import { useT } from '@/features/i18n';
import { ContactNameField } from './ContactNameField';
import { useConvertBooking } from './bookings';

export function BookingCheckoutDialog({
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
  const convert = useConvertBooking();
  const describeError = useErrorMessage();
  const contactRef = useRef<HTMLInputElement>(null);

  const [contactName, setContactName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useReportUnsavedChanges(contactName.trim().length > 0);

  const submit = () => {
    setError(null);
    const name = contactName.trim();
    if (!name) {
      setError(t('bookings.checkout.nameRequired'));
      return;
    }
    convert.mutate(
      { id: booking.id, input: { contactName: name } },
      {
        onSuccess: () => {
          onResult(t('bookings.checkout.done'), true);
          onClose();
        },
        onError: (e) => {
          const message = describeError(e, t('bookings.checkout.failed'));
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
      title={t('bookings.checkout.title')}
      description={booking.itemName}
      initialFocusRef={contactRef}
      busy={convert.isPending}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('bookings.checkout.intro')}</p>

        <ContactNameField
          ref={contactRef}
          label={t('bookings.checkout.contactLabel')}
          hint={t('bookings.checkout.contactHint')}
          value={contactName}
          onChange={setContactName}
          data-testid="booking-checkout-contact"
        />

        {error ? (
          <p role="alert" className="text-sm text-destructive" data-testid="booking-checkout-error">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={convert.isPending}>
            {t('bookings.checkout.cancel')}
          </Button>
          <Button onClick={submit} disabled={convert.isPending} data-testid="booking-checkout-confirm">
            <CheckoutIcon />
            {t('bookings.checkout.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
