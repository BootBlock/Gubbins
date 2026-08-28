/**
 * The "who is this for?" field shared by every booking surface (issue #659).
 *
 * A booking names its borrower as **free text** rather than picking from a list: an existing
 * contact is offered as a suggestion, and an unknown name is resolved-or-created on save (§4
 * Ergonomics). The new-booking form, the edit dialog and the check-out prompt all need exactly
 * that control, so it lives here once — with its `<datalist>` id minted per instance via
 * `useId`, because two of them can be on screen at the same time and a duplicated DOM id would
 * point both inputs at whichever list rendered first.
 */
import { forwardRef, useId } from 'react';
import { FormField, Input } from '@/components/foundry';
import { useContacts } from '@/features/contacts/contacts';
import { useT } from '@/features/i18n';

export interface ContactNameFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly 'data-testid'?: string;
}

export const ContactNameField = forwardRef<HTMLInputElement, ContactNameFieldProps>(function ContactNameField(
  { label, hint, value, onChange, 'data-testid': testId },
  ref,
) {
  const t = useT();
  const contacts = useContacts();
  const listId = useId();

  return (
    <div>
      <FormField label={label} hintSize="md" hint={hint}>
        <Input
          ref={ref}
          list={listId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('bookings.contact.placeholder')}
          data-testid={testId}
        />
      </FormField>
      <datalist id={listId}>
        {contacts.data?.rows.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
    </div>
  );
});
