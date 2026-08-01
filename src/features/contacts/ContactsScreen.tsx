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
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddContactIcon, ContactsIcon, DeleteIcon } from '@/components/icons';
import type { CheckoutWithNames, ContactWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { exportEveryPage } from '@/features/export/export-every-page';
import {
  buildContactsExport,
  buildLoansExport,
  contactsExportFilename,
  loansExportFilename,
} from './contacts-export';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { plural } from '@/lib/plural';
import { CheckInDialog } from './components/CheckInDialog';
import { RenewLoanDialog } from './components/RenewLoanDialog';
import { LoanRow } from './components/LoanRow';
import { EditContactDialog } from './components/EditContactDialog';
import { ContactsGettingStarted } from './components/ContactsGettingStarted';
import {
  readContactsPage,
  readOpenCheckoutsPage,
  useContactCount,
  useContacts,
  useCreateContact,
  useDeleteContact,
  useOpenCheckouts,
} from './contacts';

/**
 * The borrowing hub (spec §4 Borrowing & Checking Out, Phase 6): everything still
 * out on loan (with overdue alerts and one-tap return) plus the Contacts dictionary.
 *
 * The dictionary pages **server-side** (issue #149). It used to slice a single capped read,
 * which paged the first hundred contacts convincingly while the hundred-and-first was simply
 * unreachable and unmentioned.
 */
export function ContactsScreen() {
  const t = useT();
  const open = useOpenCheckouts();
  // App-wide list pagination (issue #20). Read the page the pager is on; unpaginated, read the
  // *first* bounded page — the ceiling is the repository's, and asking for more would clamp
  // anyway. Deliberately page 1 whatever `contactsPage` holds: switching the preference off from
  // the Settings modal leaves this screen mounted, and reading page 3 under copy that says "the
  // first 100" would be a lie.
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  const [contactsPage, setContactsPage] = useState(1);
  const contactsPageSize = paginated ? defaultPageSize : PAGE_SIZE_BOUNDS.max;
  const contacts = useContacts(paginated ? contactsPage : 1, contactsPageSize);
  const contactsTotal = useContactCount();
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

  const contactRows = contacts.data?.rows ?? [];
  // First-run guide (#424): once either list has something in it, the page speaks for
  // itself, so the guide only shows while both are confirmed (not merely loading) empty.
  // A failed load also leaves both lists empty, so exclude that — the guide would otherwise
  // greet a returning user as brand-new when their data simply didn't load (issue #306).
  const isFirstRun =
    !open.isLoading &&
    !contacts.isLoading &&
    !open.isError &&
    !contacts.isError &&
    onLoan.length === 0 &&
    contactRows.length === 0;
  // Fall back to the rows in hand when the count is unavailable, so a failed count query
  // degrades to "one page" rather than silently removing the pager from a longer list.
  const totalContacts = contactsTotal.data ?? (contacts.data ? contacts.data.offset + contactRows.length : 0);
  const contactPages = pageCount(totalContacts, contactsPageSize);
  // Unpaginated the read is capped at one page; how many contacts that leaves unreachable.
  const hiddenContacts = paginated ? 0 : Math.max(0, totalContacts - contactRows.length);
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
            : open.isError
              ? // The visible error carries its own role="alert"; keep this polite region from
                // also (mis)reporting an empty list on failure (issue #306).
                ''
              : onLoan.length === 0
                ? 'Nothing currently checked out.'
                : `${onLoan.length} ${plural(onLoan.length, 'item')} on loan${overdueCount > 0 ? `, ${overdueCount} overdue` : ''}.`}
        </p>
        <p className="sr-only" role="status" aria-live="polite" data-testid="contacts-count-live">
          {contacts.isError
            ? // The visible error carries its own role="alert"; keep this polite region from
              // also (mis)reporting an empty list on failure (issue #306).
              ''
            : contacts.data == null
              ? 'Loading contacts…'
              : totalContacts > 0
                ? // The whole dictionary, not the page in view — a per-page figure would
                  // understate how many contacts the user actually has.
                  `${totalContacts} ${plural(totalContacts, 'contact')}.`
                : 'No contacts yet.'}
        </p>

        {isFirstRun ? <ContactsGettingStarted /> : null}

        {/* On loan */}
        <section className="space-y-3">
          {/*
           * Each of the screen's two lists exports on its own (issue #132) rather than sharing
           * one control in the header: a loan row is about an item and a contact row is about a
           * person, so a single merged file would be half-empty on every row — and a single
           * trigger would not say which list it meant.
           */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">On loan</h2>
              {overdueCount > 0 ? (
                <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                  {overdueCount} overdue
                </span>
              ) : null}
            </div>
            <TabularExportMenu
              build={(format) =>
                exportEveryPage(
                  readOpenCheckoutsPage,
                  (rows) => buildLoansExport(format, rows),
                  t('export.list.truncated'),
                )
              }
              filename={loansExportFilename}
              triggerLabel={t('export.list.trigger')}
              menuLabel={t('export.loans.menuLabel')}
              toastHeading={t('export.loans.toast')}
              disabled={open.isLoading || onLoan.length === 0}
              testIdPrefix="export-loans"
            />
          </div>

          {open.isLoading ? (
            <Spinner />
          ) : open.isError ? (
            // Never fall through to the empty state on failure: "Nothing is currently checked
            // out" would read like success and hide a real error (issue #306).
            <Surface className="flex flex-col items-center gap-3 p-6 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('contacts.onLoan.error')}
              </p>
              <Button variant="outline" onClick={() => void open.refetch()}>
                {t('contacts.list.retry')}
              </Button>
            </Surface>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Contacts</h2>
            <TabularExportMenu
              build={(format) =>
                exportEveryPage(
                  readContactsPage,
                  (rows) => buildContactsExport(format, rows),
                  t('export.list.truncated'),
                )
              }
              filename={contactsExportFilename}
              triggerLabel={t('export.list.trigger')}
              menuLabel={t('export.contacts.menuLabel')}
              toastHeading={t('export.contacts.toast')}
              disabled={contacts.isLoading || totalContacts === 0}
              testIdPrefix="export-contacts"
            />
          </div>
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
          ) : contacts.isError ? (
            // Never fall through to the empty state on failure: "No contacts yet" would read
            // like success and hide a real error (issue #306).
            <Surface className="flex flex-col items-center gap-3 p-6 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('contacts.list.error')}
              </p>
              <Button variant="outline" onClick={() => void contacts.refetch()}>
                {t('contacts.list.retry')}
              </Button>
            </Surface>
          ) : contactRows.length > 0 ? (
            <>
              <ul className="grid gap-2 sm:grid-cols-2">
                {contactRows.map((c) => (
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
                  totalItems={totalContacts}
                  data-testid="contacts-pagination"
                />
              ) : hiddenContacts > 0 ? (
                // Unpaginated the read is still bounded, so say so rather than quietly showing a
                // truncated dictionary as though it were everyone.
                <p className="text-xs text-muted-foreground" data-testid="contacts-truncated">
                  {t('contacts.list.truncated', {
                    vars: { count: hiddenContacts, shown: contactRows.length },
                  })}
                </p>
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
        busy={deleteContact.isPending}
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
