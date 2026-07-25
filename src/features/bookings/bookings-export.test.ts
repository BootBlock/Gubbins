import { describe, it, expect } from 'vitest';
import type { AssetBookingWithNames } from '@/db/repositories';
import { bookingsExportColumns, bookingsExportFilename, buildBookingsExport } from './bookings-export';

const NOW = Date.parse('2026-07-25T12:00:00Z');

function booking(overrides: Partial<AssetBookingWithNames> = {}): AssetBookingWithNames {
  return {
    id: 'b1',
    itemId: 'i1',
    contactId: 'c1',
    startDate: Date.parse('2026-07-28T00:00:00Z'),
    endDate: Date.parse('2026-07-30T00:00:00Z'),
    note: 'Site visit',
    cancelledAt: null,
    convertedCheckoutId: null,
    createdAt: NOW,
    updatedAt: NOW,
    itemName: '3D printer',
    contactName: 'Alex Rivera',
    ...overrides,
  };
}

const cells = (row: AssetBookingWithNames, now = NOW): Record<string, unknown> =>
  Object.fromEntries(bookingsExportColumns(now).map((c) => [c.header, c.value(row)]));

describe('bookingsExportColumns', () => {
  it('carries what the booking card shows', () => {
    expect(cells(booking())).toEqual({
      Asset: '3D printer',
      Contact: 'Alex Rivera',
      From: '2026-07-28',
      To: '2026-07-30',
      Status: 'Upcoming',
      Cancelled: null,
      Note: 'Site visit',
    });
  });

  it('writes the booked days as calendar days, so none slips west of UTC', () => {
    // Start/end are midnight-UTC day-starts; a local-timestamp rendering would report the 27th
    // for a reader behind UTC. The date component is the booked day in every timezone.
    const row = cells(booking());
    expect(row.From).toBe('2026-07-28');
    expect(row.To).toBe('2026-07-30');
  });

  it('derives each status against the injected now, exactly as the screen groups them', () => {
    const b = booking();
    expect(cells(b, Date.parse('2026-07-25T12:00:00Z')).Status).toBe('Upcoming');
    expect(cells(b, Date.parse('2026-07-29T12:00:00Z')).Status).toBe('In use');
    expect(cells(b, Date.parse('2026-07-31T12:00:00Z')).Status).toBe('Overdue');
  });

  it('reports the terminal states, which beat the dates', () => {
    expect(cells(booking({ cancelledAt: NOW })).Status).toBe('Cancelled');
    expect(cells(booking({ convertedCheckoutId: 'k1' })).Status).toBe('Checked out');
  });

  it('records a cancellation as a real instant, not a booked day', () => {
    expect(cells(booking({ cancelledAt: Date.parse('2026-07-26T08:15:00Z') })).Cancelled).toBe(
      '2026-07-26T08:15:00.000Z',
    );
  });

  it('leaves a contact-less booking blank rather than inventing a name', () => {
    expect(cells(booking({ contactId: null, contactName: null })).Contact).toBeNull();
  });
});

describe('buildBookingsExport', () => {
  it('serialises through the shared exporter', async () => {
    const { content, extension } = await buildBookingsExport('csv', [booking()], NOW);
    expect(extension).toBe('csv');
    expect(String(content).split('\r\n')[0]).toBe('Asset,Contact,From,To,Status,Cancelled,Note');
  });

  it('captions a single booking in the singular', async () => {
    const { content } = await buildBookingsExport('txt', [booking()], NOW);
    expect(String(content)).toContain('1 booking\n');
  });
});

describe('bookingsExportFilename', () => {
  it('is date-stamped and carries the chosen extension', () => {
    expect(bookingsExportFilename('xlsx', new Date('2026-07-25T00:00:00Z'))).toBe(
      'gubbins-bookings-2026-07-25.xlsx',
    );
  });
});
