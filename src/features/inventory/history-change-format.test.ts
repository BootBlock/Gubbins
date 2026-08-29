/**
 * The Activity Log's rendering of a recorded before/after value (issue #486).
 *
 * The point of these tests is that a stored value reads as the user entered it: money as money,
 * a category id as a category name, a day-grained date in the calendar it was written in, and an
 * absent value as words rather than a blank. The second half drives the values a peer on another
 * schema version can send, because `item_history` unions across devices (§7.3) and the ledger is
 * immutable — a value of the wrong runtime type has to degrade, not disappear.
 */
import { describe, it, expect } from 'vitest';
import { getFormatters } from '@/lib/format';
import { AUDITED_ITEM_COLUMNS } from './audited-item-fields';
import { describeChange, formatChangeValue, type ChangeFormatContext } from './history-change-format';

const ctx: ChangeFormatContext = {
  formatters: getFormatters('en-GB', 'GBP', 'g', 'mm', 'ml'),
  categoryName: (id) => (id === 'cat-1' ? 'Power tools' : null),
  notSet: 'Not set',
  unknownCategory: 'Unknown category',
};

describe('formatChangeValue — one recorded value, formatted for what it is', () => {
  it('hands a price to the caller as a number, for the Money primitive to paint', () => {
    // Deliberately not a pre-formatted string: `Money` tints the currency symbol apart from the
    // digits, which is the app-wide way a price is drawn and a string could not reproduce.
    expect(formatChangeValue('money', 5.5, ctx)).toEqual({ kind: 'money', value: 5.5 });
  });

  it('renders a day-grained instant in the calendar it was written in, not the host zone', () => {
    // 2027-01-01T00:00:00Z. `date` would show 31 Dec west of Greenwich; `calendarDate` must not.
    expect(formatChangeValue('timestamp', Date.UTC(2027, 0, 1), ctx)).toEqual({
      kind: 'text',
      text: '01 Jan 2027',
    });
  });

  it('renders an ISO calendar date the same way as the instant beside it', () => {
    expect(formatChangeValue('isoDate', '2026-03-04', ctx)).toEqual({ kind: 'text', text: '04 Mar 2026' });
  });

  it('resolves a category id to its name', () => {
    expect(formatChangeValue('category', 'cat-1', ctx)).toEqual({ kind: 'text', text: 'Power tools' });
  });

  it('says so when a category no longer exists, rather than showing a raw id', () => {
    expect(formatChangeValue('category', 'cat-gone', ctx)).toEqual({
      kind: 'text',
      text: 'Unknown category',
    });
  });

  it('names the enum members rather than echoing the stored token', () => {
    expect(formatChangeValue('trackingMode', 'CONSUMABLE_GAUGE', ctx)).toEqual({
      kind: 'text',
      text: 'Consumable',
    });
    expect(formatChangeValue('condition', 'NEEDS_REPAIR', ctx)).toEqual({
      kind: 'text',
      text: 'Needs repair',
    });
  });

  it('applies the measurement, count and percentage formatters', () => {
    expect(formatChangeValue('weight', 250, ctx)).toEqual({ kind: 'text', text: '250 g' });
    expect(formatChangeValue('dimension', 120, ctx)).toEqual({ kind: 'text', text: '120 mm' });
    expect(formatChangeValue('count', 12500, ctx)).toEqual({ kind: 'text', text: '12,500' });
    // Stored 0..100; the formatter takes a 0..1 ratio, so 20 must not render as 2,000%.
    expect(formatChangeValue('percent', 20, ctx)).toEqual({ kind: 'text', text: '20%' });
  });

  it('shows an absent value as words, for every kind', () => {
    for (const { kind } of AUDITED_ITEM_COLUMNS) {
      expect(formatChangeValue(kind, null, ctx)).toEqual({ kind: 'text', text: 'Not set' });
    }
  });

  it('degrades a value of the wrong runtime type to its raw text', () => {
    // A peer on another schema version can record a string where this build expects a number.
    expect(formatChangeValue('money', 'four pounds', ctx)).toEqual({ kind: 'text', text: 'four pounds' });
    expect(formatChangeValue('weight', 'heavy', ctx)).toEqual({ kind: 'text', text: 'heavy' });
    expect(formatChangeValue('timestamp', 'soon', ctx)).toEqual({ kind: 'text', text: 'soon' });
    expect(formatChangeValue('isoDate', '4 March', ctx)).toEqual({ kind: 'text', text: '4 March' });
    expect(formatChangeValue('category', 7, ctx)).toEqual({ kind: 'text', text: '7' });
    expect(formatChangeValue('condition', 'PRISTINE', ctx)).toEqual({ kind: 'text', text: 'PRISTINE' });
  });
});

describe('describeChange — one row of the change list', () => {
  const label = (field: string) => `label:${field}`;

  it('formats both sides through the field kind the registry records', () => {
    expect(describeChange({ field: 'unitCost', from: null, to: 5.5 }, ctx, label)).toEqual({
      field: 'unitCost',
      label: 'label:unitCost',
      from: { kind: 'text', text: 'Not set' },
      to: { kind: 'money', value: 5.5 },
    });
  });

  it('falls back to plain text for a field this build does not know', () => {
    expect(describeChange({ field: 'someFutureField', from: 1, to: 2 }, ctx, label)).toEqual({
      field: 'someFutureField',
      label: 'label:someFutureField',
      from: { kind: 'text', text: '1' },
      to: { kind: 'text', text: '2' },
    });
  });
});
