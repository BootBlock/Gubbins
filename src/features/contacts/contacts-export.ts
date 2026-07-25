/**
 * Contacts & loans export (issue #132): serialise either of the Contacts screen's two lists to
 * a downloadable file — the open loans ("who has what, and when is it due back") and the
 * contacts dictionary itself.
 *
 * Two exports rather than one, because the screen shows two unrelated sets: a loan row is about
 * an item, a contact row is about a person, and a single file merging them would have a column
 * set that is half-empty on every row.
 *
 * Pure — it maps the repository DTOs onto the shared tabular column model and hands them to the
 * generic serialisers in `@/features/export/tabular-export`. Kept free of React and repositories;
 * the screen reads every page and passes the rows in.
 */
import type { CheckoutWithNames, ContactWithCount } from '@/db/repositories';
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoTimestamp, listExportFilename } from '@/features/export/export-every-page';

/**
 * The open-loans export columns.
 *
 * `Overdue` is spelled out as Yes/No rather than left as a raw boolean because this file is
 * read by a person chasing returns; the underlying due date is in the adjacent column for
 * anything that wants to re-derive it. The borrower is the display **name**, never the
 * `contactId` / `projectId` — an opaque id means nothing outside the app, and the name is what
 * the row shows.
 *
 * @internal Exported for unit tests only.
 */
export function loansExportColumns(): readonly TabularColumn<CheckoutWithNames>[] {
  return [
    { header: 'Item', value: (c) => c.itemName },
    { header: 'Borrower', value: (c) => c.borrowerName },
    { header: 'Quantity', value: (c) => c.quantity },
    { header: 'Checked out', value: (c) => isoTimestamp(c.checkedOutAt) },
    { header: 'Due', value: (c) => isoTimestamp(c.dueDate) },
    { header: 'Overdue', value: (c) => (c.isOverdue ? 'Yes' : 'No') },
    { header: 'Note', value: (c) => c.note },
  ];
}

/** Serialise the open-loans list to the chosen format via the shared exporter. */
export function buildLoansExport(
  format: TabularExportFormat,
  loans: readonly CheckoutWithNames[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, loansExportColumns(), loans, {
    title: 'On loan',
    caption: `${loans.length} loan${loans.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the loans list, e.g. `gubbins-loans-2026-07-25.csv`. */
export function loansExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('loans', extension, date);
}

/**
 * The contacts-dictionary export columns — the card's identity and contact details, plus the
 * open-loan count the card badges.
 *
 * @internal Exported for unit tests only.
 */
export function contactsExportColumns(): readonly TabularColumn<ContactWithCount>[] {
  return [
    { header: 'Name', value: (c) => c.name },
    { header: 'Email', value: (c) => c.email },
    { header: 'Mobile', value: (c) => c.phoneMobile },
    { header: 'Home phone', value: (c) => c.phoneHome },
    { header: 'Address', value: (c) => c.address },
    { header: 'Open loans', value: (c) => c.openCount },
    { header: 'Note', value: (c) => c.note },
  ];
}

/** Serialise the contacts dictionary to the chosen format via the shared exporter. */
export function buildContactsExport(
  format: TabularExportFormat,
  contacts: readonly ContactWithCount[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, contactsExportColumns(), contacts, {
    title: 'Contacts',
    caption: `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the contacts dictionary, e.g. `gubbins-contacts-2026-07-25.csv`. */
export function contactsExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('contacts', extension, date);
}
