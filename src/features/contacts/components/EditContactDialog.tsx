import { useRef, useState } from 'react';
import { Button, FormField, Input, Modal, Spinner, Textarea } from '@/components/foundry';
import { DeleteIcon } from '@/components/icons';
import type { Contact, CheckoutWithNames } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useContactCheckouts, useUpdateContact } from '../contacts';

/**
 * Edit an existing contact's details: rename them, and fill in the optional metadata
 * (phone numbers, email, address, note) that only ever gets set here — the quick-add
 * box on the Contacts screen only ever takes a name.
 */
export function EditContactDialog({
  open,
  onClose,
  contact,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  contact: Contact;
  /**
   * Delete this contact. Rendered as a left-aligned destructive action in the footer —
   * the caller owns the confirm-or-delete flow (a contact with active loans prompts
   * first, since deleting it checks those loans back in). Omit to hide the control.
   */
  onDelete?: () => void;
}) {
  const update = useUpdateContact();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(contact.name);
  const [phoneMobile, setPhoneMobile] = useState(contact.phoneMobile ?? '');
  const [phoneHome, setPhoneHome] = useState(contact.phoneHome ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [address, setAddress] = useState(contact.address ?? '');
  const [note, setNote] = useState(contact.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  // Blank fields collapse to `null` so the dirty check compares against how the
  // repository actually persists them (it collapses blanks to NULL too).
  const phoneMobileValue = phoneMobile.trim() || null;
  const phoneHomeValue = phoneHome.trim() || null;
  const emailValue = email.trim() || null;
  const addressValue = address.trim() || null;
  const noteValue = note.trim() || null;
  const dirty =
    trimmed !== contact.name ||
    phoneMobileValue !== contact.phoneMobile ||
    phoneHomeValue !== contact.phoneHome ||
    emailValue !== contact.email ||
    addressValue !== contact.address ||
    noteValue !== contact.note;

  const submit = () => {
    if (trimmed.length === 0 || !dirty) return;
    setError(null);
    update.mutate(
      {
        id: contact.id,
        input: {
          name: trimmed,
          phoneMobile: phoneMobileValue,
          phoneHome: phoneHomeValue,
          email: emailValue,
          address: addressValue,
          note: noteValue,
        },
      },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save changes to this contact.'),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit contact"
      description="Update this contact's name and details."
      initialFocusRef={nameRef}
    >
      <div className="space-y-4">
        <FormField label="Name">
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Jordan Smith"
          />
        </FormField>

        <FormField label="Mobile phone (optional)">
          <Input
            type="tel"
            value={phoneMobile}
            onChange={(e) => setPhoneMobile(e.target.value)}
            placeholder="e.g. 07700 900000"
          />
        </FormField>

        <FormField label="Home phone (optional)">
          <Input
            type="tel"
            value={phoneHome}
            onChange={(e) => setPhoneHome(e.target.value)}
            placeholder="e.g. 01632 960000"
          />
        </FormField>

        <FormField label="Email (optional)">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. jordan@example.com"
          />
        </FormField>

        <FormField label="Address (optional)">
          <Textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Their postal address, for your reference."
          />
        </FormField>

        <FormField label="Note (optional)">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything else worth remembering about this contact."
          />
        </FormField>

        <LoanHistory contactId={contact.id} />

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          {onDelete ? (
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={update.isPending}
              data-testid="edit-contact-delete"
            >
              <DeleteIcon />
              Delete contact
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={update.isPending || trimmed.length === 0 || !dirty}>
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * This contact's borrowing history (spec §4) — every item they have out or have returned,
 * newest/open first. It is the home for the loan note and the *return* note (B1): both are
 * recorded on a checkout but were previously never displayed. A loan carries the reason it
 * went out ("for the Henderson job") and a return can carry its own remark ("chipped blade,
 * now due calibration", B2), and both survive independently — so both are surfaced here.
 */
function LoanHistory({ contactId }: { contactId: string }) {
  const history = useContactCheckouts(contactId);
  const rows = history.data?.rows ?? [];

  return (
    <section className="space-y-2" aria-label="Loan history">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Loan history</h3>
      {history.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing borrowed yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((c) => (
            <LoanHistoryRow key={c.id} checkout={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LoanHistoryRow({ checkout }: { checkout: CheckoutWithNames }) {
  const fmt = useFormatters();
  const returned = checkout.returnedAt !== null;
  // Status reads at a glance from a token-tinted chip: overdue (danger) / on loan (primary) /
  // returned (muted). Colour is never the sole signal — the label always reads (WCAG 1.4.1).
  const status = checkout.isOverdue
    ? { label: 'Overdue', className: 'bg-destructive/15 text-destructive' }
    : returned
      ? { label: 'Returned', className: 'bg-secondary text-muted-foreground' }
      : { label: 'On loan', className: 'bg-primary/15 text-primary' };

  return (
    <li className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">
          {checkout.quantity > 1 ? `${checkout.quantity} × ` : ''}
          {checkout.itemName}
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>
          {status.label}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Out {fmt.date(checkout.checkedOutAt)}
        {returned ? ` · returned ${fmt.date(checkout.returnedAt!)}` : ''}
      </p>
      {checkout.note ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">Loan note:</span> “{checkout.note}”
        </p>
      ) : null}
      {checkout.returnNote ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">Return note:</span> “{checkout.returnNote}”
        </p>
      ) : null}
    </li>
  );
}
