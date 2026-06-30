import { useState } from 'react';
import { Button, Input, PageHeader, Spinner, Surface, Tooltip, INFO_OPEN_DELAY_MS, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  AddContactIcon,
  CheckInIcon,
  ContactsIcon,
  DueDateIcon,
} from '@/components/icons';
import type { CheckoutWithNames } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useContacts, useCreateContact, useOpenCheckouts, useCheckInItem } from './contacts';

/**
 * The borrowing hub (spec §4 Borrowing & Checking Out, Phase 6): everything still
 * out on loan (with overdue alerts and one-tap return) plus the Contacts dictionary.
 */
export function ContactsScreen() {
  const open = useOpenCheckouts();
  const contacts = useContacts();
  const checkIn = useCheckInItem();
  const createContact = useCreateContact();
  const [newName, setNewName] = useState('');

  const onLoan = open.data?.rows ?? [];
  const overdueCount = onLoan.filter((c) => c.isOverdue).length;

  const addContact = () => {
    if (newName.trim().length === 0) return;
    createContact.mutate({ name: newName.trim() }, { onSuccess: () => setNewName('') });
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <PageHeader icon={<ContactsIcon />} title="Contacts & borrowing" />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 animate-rise flex-col gap-6 outline-none">
      {/*
       * WCAG 4.1.3 — always-mounted polite status regions. The on-loan list and the
       * contacts list both change silently after mutations (check-in / add contact).
       * Separate regions keep the two announcements from colliding; each must be
       * mounted before data loads so the initial text mutation is announced.
       */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="contacts-on-loan-live"
      >
        {open.isLoading
          ? 'Loading on-loan items…'
          : onLoan.length === 0
            ? 'Nothing currently checked out.'
            : `${onLoan.length} item${onLoan.length === 1 ? '' : 's'} on loan${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}.`}
      </p>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="contacts-count-live"
      >
        {contacts.data == null
          ? 'Loading contacts…'
          : contacts.data.rows.length > 0
            ? `${contacts.data.rows.length} contact${contacts.data.rows.length === 1 ? '' : 's'}.`
            : 'No contacts yet.'}
      </p>
      {/* On loan */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            On loan
          </h2>
          {overdueCount > 0 ? (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
              {overdueCount} overdue
            </span>
          ) : null}
        </div>

        {open.isLoading ? (
          <Spinner />
        ) : onLoan.length === 0 ? (
          <Surface className="p-6 text-center text-sm text-muted-foreground">
            Nothing is currently checked out.
          </Surface>
        ) : (
          <ul className="space-y-2">
            {onLoan.map((c) => (
              <LoanRow
                key={c.id}
                checkout={c}
                onReturn={() => checkIn.mutate({ checkoutId: c.id })}
                returning={checkIn.isPending}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Contacts dictionary */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Contacts
        </h2>
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addContact()}
            placeholder="Add a contact…"
            className="max-w-xs"
          />
          <Button onClick={addContact} disabled={createContact.isPending || newName.trim().length === 0}>
            <AddContactIcon />
            Add
          </Button>
        </div>

        {contacts.isLoading ? (
          <Spinner />
        ) : contacts.data && contacts.data.rows.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {contacts.data.rows.map((c) => (
              <Surface
                key={c.id}
                className="flex items-center justify-between p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10"
              >
                <span className="font-medium">{c.name}</span>
                {c.openCount > 0 ? (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                    {c.openCount} out
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </Surface>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No contacts yet. They are also created automatically when you check an item out.
          </p>
        )}
      </section>
      </main>
    </div>
  );
}

function LoanRow({
  checkout,
  onReturn,
  returning,
}: {
  checkout: CheckoutWithNames;
  onReturn: () => void;
  returning: boolean;
}) {
  const fmt = useFormatters();
  const due = checkout.dueDate ? fmt.date(checkout.dueDate) : null;
  return (
    <Surface
      className={`flex flex-wrap items-center gap-3 p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10 ${
        checkout.isOverdue ? 'border-destructive/40' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{checkout.itemName}</p>
        <p className="text-xs text-muted-foreground">
          {checkout.quantity} with <span className="text-foreground">{checkout.contactName}</span>
        </p>
      </div>
      {due ? (
        <Tooltip
          content={
            checkout.isOverdue
              ? 'Past its due date — this loan is **overdue**.'
              : 'The date this loan is **due back**.'
          }
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <span
            className={`inline-flex items-center gap-1 text-xs [&_svg]:size-3.5 ${
              checkout.isOverdue ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            <DueDateIcon />
            {due}
          </span>
        </Tooltip>
      ) : null}
      <Tooltip
        content="Check this item back in. Stock returns to the location — and exact lot — it was lent from."
        triggerTabIndex={-1}
      >
        <span>
          <Button variant="outline" size="sm" onClick={onReturn} disabled={returning}>
            <CheckInIcon />
            Return
          </Button>
        </span>
      </Tooltip>
    </Surface>
  );
}
