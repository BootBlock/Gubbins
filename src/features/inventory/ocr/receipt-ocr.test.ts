import { describe, it, expect } from 'vitest';
import {
  detectCurrency,
  extractDate,
  extractPrice,
  hasAnyCandidate,
  parseMoneyNumber,
  parseReceiptText,
} from './receipt-ocr';

describe('parseMoneyNumber', () => {
  it('parses plain and symboled decimals', () => {
    expect(parseMoneyNumber('12.99')).toBe(12.99);
    expect(parseMoneyNumber('£12.99')).toBe(12.99);
    expect(parseMoneyNumber('$5')).toBe(5);
    expect(parseMoneyNumber('€ 3.50')).toBe(3.5);
    expect(parseMoneyNumber('1234')).toBe(1234);
  });

  it('handles UK/US grouping with a dot decimal', () => {
    expect(parseMoneyNumber('1,234.56')).toBe(1234.56);
    expect(parseMoneyNumber('1,000,000.00')).toBe(1000000);
    expect(parseMoneyNumber('10,000')).toBe(10000); // trailing 3 digits → grouping
  });

  it('handles EU grouping with a comma decimal', () => {
    expect(parseMoneyNumber('1.234,56')).toBe(1234.56);
    expect(parseMoneyNumber('1.000.000,00')).toBe(1000000);
    expect(parseMoneyNumber('12,99')).toBe(12.99); // trailing 2 digits → decimal
    expect(parseMoneyNumber('12,5')).toBe(12.5); // trailing 1 digit → decimal
  });

  it('treats a lone thousands separator as grouping', () => {
    expect(parseMoneyNumber('1,234')).toBe(1234);
    expect(parseMoneyNumber('1.234')).toBe(1234);
  });

  it('keeps a high-precision unit price, which is never grouping (issue #340)', () => {
    // Component distributors quote four decimal places; a 4+ digit tail cannot be a
    // thousands group, so it must read as a fraction rather than being inflated.
    expect(parseMoneyNumber('0.0012')).toBe(0.0012);
    expect(parseMoneyNumber('4.9557')).toBe(4.9557);
    expect(parseMoneyNumber('0,0012')).toBe(0.0012);
  });

  it('reads a three-decimal fraction as a fraction when it cannot be grouping (issue #340)', () => {
    // A leading "0" is never a thousands-group lead, so these are sub-penny prices, not
    // grouped integers — 0.005 must not become 5.
    expect(parseMoneyNumber('0.005')).toBe(0.005);
    expect(parseMoneyNumber('0,005')).toBe(0.005);
    // Nor is a four-digit lead: 1234.567 was already unambiguous.
    expect(parseMoneyNumber('1234.567')).toBe(1234.567);
    // ...but a well-formed group still groups.
    expect(parseMoneyNumber('1.500')).toBe(1500);
  });

  it('handles multiple same-type separators with a decimal tail', () => {
    expect(parseMoneyNumber('1,234,56')).toBe(1234.56); // grouping + decimal, both commas
    expect(parseMoneyNumber('1.234.567')).toBe(1234567); // pure grouping, three dots
  });

  it('parses a negative amount (refund line)', () => {
    expect(parseMoneyNumber('-5.00')).toBe(-5);
  });

  it('rejects non-monetary tokens', () => {
    expect(parseMoneyNumber('abc')).toBeNull();
    expect(parseMoneyNumber('')).toBeNull();
    expect(parseMoneyNumber('12a34')).toBeNull();
    expect(parseMoneyNumber('--5')).toBeNull();
  });
});

describe('detectCurrency', () => {
  it('detects by symbol (symbol wins over a written code)', () => {
    expect(detectCurrency('Total £12.99')).toBe('GBP');
    expect(detectCurrency('Amount due $5.00')).toBe('USD');
    expect(detectCurrency('€3,50')).toBe('EUR');
    expect(detectCurrency('¥1200')).toBe('JPY');
    expect(detectCurrency('₹450')).toBe('INR');
  });

  it('falls back to a written ISO code', () => {
    expect(detectCurrency('TOTAL 12.99 GBP')).toBe('GBP');
    expect(detectCurrency('Paid USD 5.00')).toBe('USD');
    expect(detectCurrency('12.99 chf')).toBe('CHF');
  });

  it('returns undefined when no currency is present', () => {
    expect(detectCurrency('Total 12.99')).toBeUndefined();
    expect(detectCurrency('nothing here')).toBeUndefined();
  });
});

describe('extractPrice', () => {
  it('prefers a total line over other amounts', () => {
    const lines = ['Widget 3.00', 'Gadget 4.50', 'Total 7.50'];
    expect(extractPrice(lines, 'GBP')).toEqual({
      value: { amount: 7.5, currency: 'GBP' },
      source: 'Total 7.50',
    });
  });

  it('ranks grand total / amount due above a bare total', () => {
    const lines = ['Total 7.50', 'Grand Total 9.00'];
    expect(extractPrice(lines, undefined)?.value.amount).toBe(9);
    expect(extractPrice(['Total 7.50', 'Amount Due 9.00'], undefined)?.value.amount).toBe(9);
  });

  it('excludes subtotal / tax-total / savings lines', () => {
    const lines = ['Subtotal 10.00', 'VAT Total 2.00', 'Total Savings 3.00', 'Total 12.00'];
    expect(extractPrice(lines, 'GBP')?.value.amount).toBe(12);
  });

  it('takes the last amount on a total line (label then figure)', () => {
    const lines = ['Total 3 items 12.99'];
    expect(extractPrice(lines, 'GBP')?.value.amount).toBe(12.99);
  });

  it('falls back to the largest genuinely-priced amount when no total keyword exists', () => {
    const lines = ['Cable £3.00', 'Board £12.99', 'Screw £0.50', 'Qty 5'];
    const result = extractPrice(lines, 'GBP');
    expect(result?.value.amount).toBe(12.99);
    expect(result?.source).toBe('Board £12.99');
  });

  it('threads the detected currency (or omits it)', () => {
    expect(extractPrice(['Total £5.00'], 'GBP')?.value).toEqual({ amount: 5, currency: 'GBP' });
    expect(extractPrice(['Total 5.00'], undefined)?.value).toEqual({ amount: 5 });
  });

  it('ignores a trailing slash-date on a total line and keeps the priced figure', () => {
    // The tokeniser splits "15/03/2024" into 15, 03, 2024 — the year must not win over 12.99.
    expect(extractPrice(['Total 12.99 15/03/2024'], 'GBP')?.value.amount).toBe(12.99);
  });

  it('returns undefined when there is no amount', () => {
    expect(extractPrice(['Thank you for shopping', 'Come again'], undefined)).toBeUndefined();
  });
});

describe('extractDate', () => {
  it('parses day-first numeric dates (en-GB default)', () => {
    expect(extractDate(['Date: 03/04/2024'])?.value).toBe('2024-04-03');
    expect(extractDate(['05.11.2023'])?.value).toBe('2023-11-05');
    expect(extractDate(['05-11-2023'])?.value).toBe('2023-11-05');
  });

  it('swaps to month-first only when the numbers force it', () => {
    expect(extractDate(['13/04/2024'])?.value).toBe('2024-04-13'); // first > 12 → day
    expect(extractDate(['04/13/2024'])?.value).toBe('2024-04-13'); // second > 12 → US order
  });

  it('parses ISO and 2-digit years', () => {
    expect(extractDate(['2024-03-15'])?.value).toBe('2024-03-15');
    expect(extractDate(['15/03/24'])?.value).toBe('2024-03-15');
  });

  it('parses textual month dates in either order', () => {
    expect(extractDate(['15 Mar 2024'])?.value).toBe('2024-03-15');
    expect(extractDate(['15th March, 2024'])?.value).toBe('2024-03-15');
    expect(extractDate(['March 15, 2024'])?.value).toBe('2024-03-15');
    expect(extractDate(['Mar 15 2024'])?.value).toBe('2024-03-15');
  });

  it('prefers a labelled date over a stray one', () => {
    const lines = ['2020-01-01', 'Purchased: 15/03/2024'];
    expect(extractDate(lines)?.value).toBe('2024-03-15');
  });

  it('rejects impossible dates and 2-part MM/YY fragments', () => {
    expect(extractDate(['31/02/2024'])).toBeUndefined(); // no 31st Feb
    expect(extractDate(['Valid thru 08/27'])).toBeUndefined(); // card expiry, not a full date
    expect(extractDate(['13/13/2024'])).toBeUndefined(); // no valid month
  });

  it('rejects a future date beyond the reference year', () => {
    expect(extractDate(['01/01/2099'], 2024)).toBeUndefined();
    expect(extractDate(['01/01/2025'], 2024)?.value).toBe('2025-01-01'); // next year allowed
  });

  it('returns undefined when no date is present', () => {
    expect(extractDate(['no date here', 'Total 5.00'])).toBeUndefined();
  });
});

describe('parseReceiptText — labelled codes', () => {
  it('extracts an MPN / model / part number', () => {
    expect(parseReceiptText('Model: NE555P').mpn?.value).toBe('NE555P');
    expect(parseReceiptText('MPN LM317T').mpn?.value).toBe('LM317T');
    expect(parseReceiptText('Part No: 1826764').mpn?.value).toBe('1826764');
    expect(parseReceiptText('P/N: ABC-123-X').mpn?.value).toBe('ABC-123-X');
  });

  it('extracts a serial number', () => {
    expect(parseReceiptText('Serial No: SN12345678').serial?.value).toBe('SN12345678');
    expect(parseReceiptText('S/N ABCD1234').serial?.value).toBe('ABCD1234');
  });

  it('trims trailing punctuation the label regex may grab', () => {
    expect(parseReceiptText('Model: NE555P.').mpn?.value).toBe('NE555P');
  });

  it('ignores a labelled value with no digit (not a code)', () => {
    expect(parseReceiptText('Model: Deluxe').mpn).toBeUndefined();
  });
});

describe('parseReceiptText — integration', () => {
  it('parses a full synthetic receipt', () => {
    const raw = [
      'ACME HARDWARE LTD',
      '12 Example Street',
      'Date: 15/03/2024',
      '',
      'NE555 Timer IC   £2.50',
      'Model: NE555P',
      'Serial No: SN-00042',
      'Subtotal      £2.50',
      'VAT 20%        £0.50',
      'Total to pay   £3.00',
      'Thank you!',
    ].join('\n');
    const result = parseReceiptText(raw);
    expect(result.price).toEqual({
      value: { amount: 3, currency: 'GBP' },
      source: 'Total to pay   £3.00',
    });
    expect(result.acquiredAt?.value).toBe('2024-03-15');
    expect(result.mpn?.value).toBe('NE555P');
    expect(result.serial?.value).toBe('SN-00042');
    expect(hasAnyCandidate(result)).toBe(true);
  });

  it('parses a EU-format receipt with comma decimals', () => {
    const raw = ['Kaufdatum: 04.02.2023', 'Gesamt 1.299,00 EUR'].join('\n');
    const result = parseReceiptText(raw);
    expect(result.price?.value).toEqual({ amount: 1299, currency: 'EUR' });
    expect(result.acquiredAt?.value).toBe('2023-02-04');
  });

  it('is fail-soft on noise and empty input', () => {
    expect(hasAnyCandidate(parseReceiptText(''))).toBe(false);
    expect(hasAnyCandidate(parseReceiptText('   \n  \n '))).toBe(false);
    expect(hasAnyCandidate(parseReceiptText('just some words with a number 7 in them'))).toBe(false);
    expect(parseReceiptText('garbled  text')).toEqual({});
  });

  it('omits fields that were not found', () => {
    const result = parseReceiptText('Total £9.99');
    expect(result.price?.value.amount).toBe(9.99);
    expect(result.acquiredAt).toBeUndefined();
    expect(result.mpn).toBeUndefined();
    expect(result.serial).toBeUndefined();
  });
});
