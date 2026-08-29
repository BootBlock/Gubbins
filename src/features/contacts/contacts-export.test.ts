import { describe, it, expect } from 'vitest';
import type { CheckoutWithNames, ContactWithCount } from '@/db/repositories';
import {
  buildContactsExport,
  buildLoansExport,
  contactsExportColumns,
  contactsExportFilename,
  loansExportColumns,
  loansExportFilename,
} from './contacts-export';

function loan(overrides: Partial<CheckoutWithNames> = {}): CheckoutWithNames {
  return {
    id: 'k1',
    itemId: 'i1',
    borrowerType: 'CONTACT',
    contactId: 'c1',
    projectId: null,
    locationId: null,
    quantity: 2,
    returnedQuantity: 0,
    dueDate: Date.parse('2026-08-01T00:00:00Z'),
    checkedOutAt: Date.parse('2026-07-20T10:00:00Z'),
    returnedAt: null,
    note: 'For the workshop.',
    returnNote: null,
    sourceLocationId: null,
    sourceBatchKey: null,
    updatedAt: Date.parse('2026-07-20T10:00:00Z'),
    itemName: 'Cordless drill',
    borrowerName: 'Alex Rivera',
    status: 'OPEN',
    isOverdue: false,
    ...overrides,
  };
}

function contact(overrides: Partial<ContactWithCount> = {}): ContactWithCount {
  return {
    id: 'c1',
    name: 'Alex Rivera',
    note: 'Workshop lead',
    phoneMobile: '07700 900000',
    phoneHome: null,
    email: 'alex@example.com',
    address: '1 Example Street',
    createdAt: 0,
    updatedAt: 0,
    openCount: 2,
    ...overrides,
  };
}

const loanCells = (row: CheckoutWithNames): Record<string, unknown> =>
  Object.fromEntries(loansExportColumns().map((c) => [c.header, c.value(row)]));

const contactCells = (row: ContactWithCount): Record<string, unknown> =>
  Object.fromEntries(contactsExportColumns().map((c) => [c.header, c.value(row)]));

describe('loansExportColumns', () => {
  it('carries what the loan row shows, with timestamps in ISO form', () => {
    expect(loanCells(loan())).toEqual({
      Item: 'Cordless drill',
      Borrower: 'Alex Rivera',
      Quantity: 2,
      'Still out': 2,
      'Checked out': '2026-07-20T10:00:00.000Z',
      Due: '2026-08-01T00:00:00.000Z',
      Overdue: 'No',
      Note: 'For the workshop.',
    });
  });

  it('states what is still out, not the size of the loan, once part of it is back', () => {
    // A partly-returned loan (issue #662) is still open, so it appears in this export — and the
    // figure a person chasing returns needs is the four the borrower still has, not the six.
    const cells = loanCells(loan({ quantity: 6, returnedQuantity: 2 }));
    expect(cells.Quantity).toBe(6);
    expect(cells['Still out']).toBe(4);
  });

  it('spells overdue out for a person chasing returns', () => {
    expect(loanCells(loan({ isOverdue: true })).Overdue).toBe('Yes');
  });

  it('leaves an open-ended loan’s due date blank', () => {
    expect(loanCells(loan({ dueDate: null })).Due).toBeNull();
  });

  it('names the borrower rather than an opaque id', () => {
    const headers = loansExportColumns().map((c) => c.header);
    expect(headers).toContain('Borrower');
    expect(headers).not.toContain('contactId');
    expect(loanCells(loan({ borrowerName: 'Bench project', contactId: null })).Borrower).toBe(
      'Bench project',
    );
  });
});

describe('contactsExportColumns', () => {
  it('carries the card’s identity, details and open-loan count', () => {
    expect(contactCells(contact())).toEqual({
      Name: 'Alex Rivera',
      Email: 'alex@example.com',
      Mobile: '07700 900000',
      'Home phone': null,
      Address: '1 Example Street',
      'Open loans': 2,
      Note: 'Workshop lead',
    });
  });

  it('keeps the open-loan count a raw number a spreadsheet can total', () => {
    expect(contactCells(contact({ openCount: 0 }))['Open loans']).toBe(0);
  });
});

describe('buildLoansExport / buildContactsExport', () => {
  it('serialise as two documents, not one merged half-empty table', async () => {
    const loans = await buildLoansExport('csv', [loan()]);
    const contacts = await buildContactsExport('csv', [contact()]);
    expect(String(loans.content).split('\r\n')[0]).toBe(
      'Item,Borrower,Quantity,Still out,Checked out,Due,Overdue,Note',
    );
    expect(String(contacts.content).split('\r\n')[0]).toBe(
      'Name,Email,Mobile,Home phone,Address,Open loans,Note',
    );
  });

  it('caption a single row in the singular', async () => {
    expect(String((await buildLoansExport('txt', [loan()])).content)).toContain('1 loan\n');
    expect(String((await buildContactsExport('txt', [contact()])).content)).toContain('1 contact\n');
  });
});

describe('filenames', () => {
  it('name each list separately so both can sit in one downloads folder', () => {
    const date = new Date('2026-07-25T00:00:00Z');
    expect(loansExportFilename('csv', date)).toBe('gubbins-loans-2026-07-25.csv');
    expect(contactsExportFilename('csv', date)).toBe('gubbins-contacts-2026-07-25.csv');
  });
});
