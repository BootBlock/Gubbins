import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  PageContainer,
  PageHeader,
  Pagination,
  Spinner,
  Surface,
  pageCount,
  pageSliceBounds,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddContactIcon, ContactsIcon, DeleteIcon } from '@/components/icons';
import type { CheckoutWithNames, ContactWithCount } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { plural } from '@/lib/plural';
import { CheckInDialog } from './components/CheckInDialog';
import { RenewLoanDialog } from './components/RenewLoanDialog';
import { LoanRow } from './components/LoanRow';
import { EditContactDialog } from './components/EditContactDialog';
import { useContacts, useCreateContact, useDeleteContact, useOpenCheckouts } from './contacts';

/**
 * The borrowing hub (spec §4 Borrowing & Checking Out, Phase 6): everything still
 * out on loan (with overdue alerts and one-tap return) plus the Contacts dictionary.
 */
export function ContactsScreen() {
  const open = useOpenCheckouts();
  const contacts = useContacts();
  const createContact = useCreateContact();
  const deleteContact = useDeleteContact();
  const [newName, setNewName] = useState('');
  // The loan whose return dialog is open (capturing the item's condition on return + a return
  // note, B2). Null = no return in progress; a "Return" tap opens the dialog for that checkout.
  const [returningCheckout, setReturningCheckout] = useState<CheckoutWithNames | null>(null);
  // The loan whose renew (change-due-date) dialog is open (B3). Null = none in progress; a
  // "Renew" tap opens the dialog for that checkout, editing its due date in place.
  const [renewingCheckout, setRenewingCheckout] = useState<CheckoutWithNames | null>(null);
  // The contact open in the full Edit dialog (click a card), and one pending a delete
  // confirmation. A contact with no active loans deletes straight away; only one still
  // borrowing/loaning something prompts first, since deleting it checks those loans back in.
  const [editingContact, setEditingContact] = useState<ContactWithCount | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    id: string;
    name: string;
    openCount: number;
  } | null>(null);

  const onLoan = open.data?.rows ?? [];
  const overdueCount = onLoan.filter((c) => c.isOverdue).length;

  // App-wide list pagination (issue #20). The contacts dictionary is a plain client-side list
  // (already capped at 100 rows), so it paginates by slicing the loaded rows — no extra query.
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  const [contactsPage, setContactsPage] = useState(1);
  const contactRows = contacts.data?.rows ?? [];
  const contactPages = pageCount(contactRows.length, defaultPageSize);
  const { start, end } = pageSliceBounds(contactsPage, defaultPageSize, contactRows.length);
  const visibleContacts = paginated ? contactRows.slice(start, end) : contactRows;
  // Clamp back into range if the list shrinks (a contact deleted) below the current page.
  useEffect(() => {
    if (paginated && contactPages > 0 && contactsPage > contactPages) setContactsPage(contactPages);
  }, [paginated, contactPages, contactsPage]);

  const addContact = () => {
    if (newName.trim().length === 0) return;
    createContact.mutate({ name: newName.trim() }, { onSuccess: () => setNewName('') });
  };

  const requestDelete = (contact: ContactWithCount) => {
    if (contact.openCount === 0) {
      deleteContact.mutate(contact.id);
      setEditingContact(null);
      return;
    }
    setConfirmDelete({ id: contact.id, name: contact.name, openCount: contact.openCount });
  };

  const confirmDeleteNow = () => {
    if (!confirmDelete) return;
    deleteContact.mutate(confirmDelete.id, {
      onSuccess: () => {
        setConfirmDelete(null);
        setEditingContact(null);
      },
    });
  };

  return (
    <PageContainer>
      <PageHeader icon={<ContactsIcon />} title="Contacts & borrowing" />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {/*
         * WCAG 4.1.3 — always-mounted polite status regions. The on-loan list and the
         * contacts list both change silently after mutations (check-in / add contact).
         * Separate regions keep the two announcements from colliding; each must be
         * mounted before data loads so the initial text mutation is announced.
         */}
        <p className="sr-only" role="status" aria-live="polite" data-testid="contacts-on-loan-live">
          {open.isLoading
            ? 'Loading on-loan items…'
            : onLoan.length === 0
              ? 'Nothing currently checked out.'
              : `${onLoan.length} ${plural(onLoan.length, 'item')} on loan${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}.`}
        </p>
        <p className="sr-only" role="status" aria-live="polite" data-testid="contacts-count-live">
          {contacts.data == null
            ? 'Loading contacts…'
            : contacts.data.rows.length > 0
              ? `${contacts.data.rows.length} ${plural(contacts.data.rows.length, 'contact')}.`
              : 'No contacts yet.'}
        </p>
        {/* On loan */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">On loan</h2>
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
                  onReturn={() => setReturningCheckout(c)}
                  onRenew={() => setRenewingCheckout(c)}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Contacts dictionary */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Contacts</h2>
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
          ) : contactRows.length > 0 ? (
            <>
              <ul className="grid gap-2 sm:grid-cols-2">
                {visibleContacts.map((c) => (
                  <Surface
                    key={c.id}
                    className="transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10"
                  >
                    <button
                      type="button"
                      onClick={() => setEditingContact(c)}
                      className="flex w-full items-center justify-between gap-2 rounded-[inherit] p-3 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <span className="font-medium">{c.name}</span>
                      {c.openCount > 0 ? (
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                          {c.openCount} out
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </button>
                  </Surface>
                ))}
              </ul>
              {paginated ? (
                <Pagination
                  page={contactsPage}
                  pageCount={contactPages}
                  onPageChange={setContactsPage}
                  pageSize={defaultPageSize}
                  onPageSizeChange={setDefaultPageSize}
                  pageSizeOptions={PAGE_SIZE_PRESETS}
                  minPageSize={PAGE_SIZE_BOUNDS.min}
                  maxPageSize={PAGE_SIZE_BOUNDS.max}
                  totalItems={contactRows.length}
                  data-testid="contacts-pagination"
                />
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No contacts yet. They are also created automatically when you check an item out.
            </p>
          )}
        </section>
      </main>

      {returningCheckout ? (
        <CheckInDialog open onClose={() => setReturningCheckout(null)} checkout={returningCheckout} />
      ) : null}

      {renewingCheckout ? (
        <RenewLoanDialog open onClose={() => setRenewingCheckout(null)} checkout={renewingCheckout} />
      ) : null}

      {editingContact ? (
        <EditContactDialog
          open
          onClose={() => setEditingContact(null)}
          contact={editingContact}
          onDelete={() => requestDelete(editingContact)}
        />
      ) : null}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete contact?"
        description={
          confirmDelete
            ? `"${confirmDelete.name}" is currently borrowing/loaning ${confirmDelete.openCount} ${plural(confirmDelete.openCount, 'item')}. Deleting this contact will check ${confirmDelete.openCount === 1 ? 'it' : 'them'} back in as returned. Are you sure you want to delete this contact?`
            : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deleteContact.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirmDeleteNow}
            disabled={deleteContact.isPending}
            data-testid="confirm-delete-contact"
          >
            {deleteContact.isPending ? <Spinner /> : <DeleteIcon />}
            Delete contact
          </Button>
        </div>
      </Modal>
    </PageContainer>
  );
}
