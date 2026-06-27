import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Input, Spinner, Surface, Tooltip } from '@/components/foundry';
import {
  AddContactIcon,
  BrandIcon,
  CheckInIcon,
  ContactsIcon,
  DueDateIcon,
  PackageIcon,
} from '@/components/icons';
import type { CheckoutWithNames } from '@/db/repositories';
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
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <span className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary [&_svg]:size-5">
            <BrandIcon />
          </span>
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <ContactsIcon /> Contacts &amp; borrowing
        </h1>
        <Link
          to="/inventory"
          className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <PackageIcon />
          Inventory
        </Link>
      </header>

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
              <Surface key={c.id} className="flex items-center justify-between p-3">
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
  const due = checkout.dueDate
    ? new Date(checkout.dueDate).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null;
  return (
    <Surface
      className={`flex flex-wrap items-center gap-3 p-3 ${
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
        <Tooltip content={checkout.isOverdue ? 'Overdue' : 'Due back'}>
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
      <Button variant="outline" size="sm" onClick={onReturn} disabled={returning}>
        <CheckInIcon />
        Return
      </Button>
    </Surface>
  );
}
