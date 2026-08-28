import { describe, expect, it } from 'vitest';
import {
  parsePurchaseList,
  purchaseLineLabel,
  purchaseLineMatchKeys,
  PurchaseListImportError,
  toWishlistDraft,
  type ParsedPurchaseListLine,
} from './purchase-list-import';
import { UNTERMINATED_QUOTE_NOTE } from '@/features/import/tabular';

/** A parsed line with every field absent, for building focused expectations. */
const EMPTY: ParsedPurchaseListLine = {
  name: null,
  mpn: null,
  supplierSku: null,
  supplierName: null,
  quantity: 1,
  unitPrice: null,
  url: null,
  note: null,
  priority: null,
};

describe('parsePurchaseList — rejection', () => {
  it('rejects empty input', () => {
    expect(() => parsePurchaseList('   ')).toThrow(PurchaseListImportError);
  });

  it('rejects a table with no column that could name a purchase', () => {
    expect(() => parsePurchaseList('Quantity,Price\n2,3.00')).toThrow(
      /No recognisable purchase-list columns/,
    );
  });

  it('points at the “Line list” escape hatch when a table has no usable columns', () => {
    expect(() => parsePurchaseList('Quantity,Price\n2,3.00')).toThrow(/Line list/);
  });

  it('rejects a table whose every data row is blank', () => {
    expect(() => parsePurchaseList('Name,Qty\n , \n , ')).toThrow(/every row was blank/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePurchaseList('{ "items": ', { format: 'json' })).toThrow(PurchaseListImportError);
  });

  it('names an unclosed quote rather than blaming the columns (issue #591)', () => {
    const csv = ['Name,Qty', '"Widget,2', 'Gadget,1'].join('\n');
    expect(() => parsePurchaseList(csv)).toThrow(UNTERMINATED_QUOTE_NOTE);
  });

  it('keeps an inch mark in a name instead of swallowing the rest of the file (issue #591)', () => {
    const csv = ['Name,Qty', '3/4" ball valve,5', 'Widget,2'].join('\n');
    const { lines } = parsePurchaseList(csv);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ name: '3/4" ball valve', quantity: 5 });
    expect(lines[1]).toMatchObject({ name: 'Widget', quantity: 2 });
  });
});

describe('parsePurchaseList — delimited', () => {
  it('maps the common purchase columns', () => {
    const {
      lines: [line],
    } = parsePurchaseList(
      'Description,Qty,Unit price,Supplier,Link,Note\nM3 bolt,50,0.04,Fastenings Direct,https://example.com/m3,Hex head',
    );
    expect(line).toEqual({
      ...EMPTY,
      name: 'M3 bolt',
      quantity: 50,
      unitPrice: 0.04,
      supplierName: 'Fastenings Direct',
      url: 'https://example.com/m3',
      note: 'Hex head',
    });
  });

  it('recognises header synonyms regardless of case and punctuation', () => {
    const {
      lines: [line],
    } = parsePurchaseList('Product Name,QTY,Price Each\nWidget,3,1.50');
    expect(line).toMatchObject({ name: 'Widget', quantity: 3, unitPrice: 1.5 });
  });

  it('splits manufacturer part numbers from supplier order codes', () => {
    const {
      lines: [line],
    } = parsePurchaseList('MPN,Order code,Qty\nNE555P,FE-1234,10');
    expect(line).toMatchObject({ mpn: 'NE555P', supplierSku: 'FE-1234', quantity: 10 });
  });

  it('defaults a missing or blank quantity to 1', () => {
    const { lines, problems } = parsePurchaseList('Name,Qty\nA,\nB,  ');
    expect(lines.map((l) => l.quantity)).toEqual([1, 1]);
    expect(problems).toEqual([]);
  });

  it('derives the unit price from a line total when no unit price is given', () => {
    const {
      lines: [line],
    } = parsePurchaseList('Name,Qty,Total\nWidget,4,10.00');
    expect(line!.unitPrice).toBe(2.5);
  });

  it('prefers an explicit unit price over a line total', () => {
    const {
      lines: [line],
    } = parsePurchaseList('Name,Qty,Unit price,Total\nWidget,4,3.00,10.00');
    expect(line!.unitPrice).toBe(3);
  });

  it('leaves the price unknown rather than inventing a zero', () => {
    const {
      lines: [line],
    } = parsePurchaseList('Name,Qty\nWidget,4');
    expect(line!.unitPrice).toBeNull();
  });

  it('reads a currency-formatted price', () => {
    const {
      lines: [line],
    } = parsePurchaseList('Name,Price\nWidget,"£1,234.56"');
    expect(line!.unitPrice).toBe(1234.56);
  });

  it('skips a blank row without failing the import', () => {
    const { lines } = parsePurchaseList('Name,Qty\nA,1\n,\nB,2');
    expect(lines.map((l) => l.name)).toEqual(['A', 'B']);
  });

  it('accepts a tab-separated paste', () => {
    const { lines } = parsePurchaseList('Name\tQty\nWidget\t2');
    expect(lines).toEqual([{ ...EMPTY, name: 'Widget', quantity: 2 }]);
  });
});

describe('parsePurchaseList — quantities the file actually stated (issue #350)', () => {
  it('leaves out a zero-quantity row instead of ordering one of it', () => {
    const { lines, problems } = parsePurchaseList('Name,Qty\nWanted,2\nDeselected,0');
    expect(lines.map((l) => l.name)).toEqual(['Wanted']);
    expect(problems).toEqual([{ sourceRow: 2, label: 'Deselected', reason: 'zero', value: '0' }]);
  });

  it('reports an unreadable quantity rather than ordering one', () => {
    const { lines, problems } = parsePurchaseList('Name,Qty\nWidget,lots');
    expect(lines).toEqual([]);
    expect(problems).toEqual([{ sourceRow: 1, label: 'Widget', reason: 'unreadable', value: 'lots' }]);
  });

  it('reports a fractional quantity rather than rounding it up', () => {
    const { problems } = parsePurchaseList('Name,Qty\nWidget,2.5');
    expect(problems).toEqual([{ sourceRow: 1, label: 'Widget', reason: 'fractional', value: '2.5' }]);
  });

  it('reports a negative quantity', () => {
    const { problems } = parsePurchaseList('Name,Qty\nWidget,-4');
    expect(problems).toEqual([{ sourceRow: 1, label: 'Widget', reason: 'negative', value: '-4' }]);
  });

  it('explains a wholly de-selected file instead of claiming every row was blank', () => {
    const { lines, problems } = parsePurchaseList('Name,Qty\nA,0\nB,0');
    expect(lines).toEqual([]);
    expect(problems).toHaveLength(2);
  });

  it('leaves out a zero-quantity line in a typed free-form list', () => {
    const { lines, problems } = parsePurchaseList('3x M3 bolts\n0 tea towels', { format: 'lines' });
    expect(lines.map((l) => l.name)).toEqual(['M3 bolts']);
    expect(problems).toEqual([{ sourceRow: 2, label: 'tea towels', reason: 'zero', value: '0' }]);
  });
});

describe('parsePurchaseList — structured formats', () => {
  it('reads an array of JSON objects', () => {
    const { lines } = parsePurchaseList('[{"name":"Widget","qty":2,"price":"1.50"}]');
    expect(lines).toEqual([{ ...EMPTY, name: 'Widget', quantity: 2, unitPrice: 1.5 }]);
  });

  it('reads a Markdown table', () => {
    const { lines } = parsePurchaseList('| Name | Qty |\n| --- | --- |\n| Widget | 3 |');
    expect(lines).toEqual([{ ...EMPTY, name: 'Widget', quantity: 3 }]);
  });

  it('reads an HTML table', () => {
    const { lines } = parsePurchaseList(
      '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Widget</td><td>3</td></tr></table>',
    );
    expect(lines).toEqual([{ ...EMPTY, name: 'Widget', quantity: 3 }]);
  });
});

describe('parsePurchaseList — free-form list', () => {
  it('takes one thing per line', () => {
    const { lines } = parsePurchaseList('Masking tape\nSandpaper', { format: 'lines' });
    expect(lines.map((l) => l.name)).toEqual(['Masking tape', 'Sandpaper']);
    expect(lines.every((l) => l.quantity === 1)).toBe(true);
  });

  it('honours a leading quantity', () => {
    const { lines } = parsePurchaseList('3x M3 bolts\n2 × sanding blocks\n5 tea towels', { format: 'lines' });
    expect(lines).toEqual([
      { ...EMPTY, name: 'M3 bolts', quantity: 3 },
      { ...EMPTY, name: 'sanding blocks', quantity: 2 },
      { ...EMPTY, name: 'tea towels', quantity: 5 },
    ]);
  });

  it('honours a trailing quantity', () => {
    const { lines } = parsePurchaseList('Sanding blocks x4', { format: 'lines' });
    expect(lines).toEqual([{ ...EMPTY, name: 'Sanding blocks', quantity: 4 }]);
  });

  it('prefers a leading quantity over a trailing one', () => {
    const { lines } = parsePurchaseList('2x Widget x4', { format: 'lines' });
    expect(lines).toEqual([{ ...EMPTY, name: 'Widget x4', quantity: 2 }]);
  });

  it('strips list bullets and numbering', () => {
    const { lines } = parsePurchaseList('- Masking tape\n* Sandpaper\n1. Glue\n• Brushes', {
      format: 'lines',
    });
    expect(lines.map((l) => l.name)).toEqual(['Masking tape', 'Sandpaper', 'Glue', 'Brushes']);
  });

  it('ignores blank lines', () => {
    const { lines } = parsePurchaseList('Tape\n\n\nGlue', { format: 'lines' });
    expect(lines).toHaveLength(2);
  });

  it('is chosen by auto-detection for a plain typed list', () => {
    const { lines } = parsePurchaseList('Masking tape\nSandpaper\nGlue');
    expect(lines.map((l) => l.name)).toEqual(['Masking tape', 'Sandpaper', 'Glue']);
  });

  it('rejects input that yields no usable line', () => {
    expect(() => parsePurchaseList('- \n* ', { format: 'lines' })).toThrow(/every row was blank/);
  });
});

describe('purchaseLineLabel', () => {
  it('prefers the name, then the MPN, then the supplier code', () => {
    expect(purchaseLineLabel({ ...EMPTY, name: 'Widget', mpn: 'NE555P' })).toBe('Widget');
    expect(purchaseLineLabel({ ...EMPTY, mpn: 'NE555P', supplierSku: 'FE-1' })).toBe('NE555P');
    expect(purchaseLineLabel({ ...EMPTY, supplierSku: 'FE-1' })).toBe('FE-1');
  });

  it('falls back to a placeholder when the line names nothing', () => {
    expect(purchaseLineLabel(EMPTY)).toBe('Unnamed line');
  });
});

describe('purchaseLineMatchKeys', () => {
  it('tries the MPN before the supplier code', () => {
    expect(purchaseLineMatchKeys({ ...EMPTY, mpn: 'NE555P', supplierSku: 'FE-1' })).toEqual([
      'NE555P',
      'FE-1',
    ]);
  });

  it('is empty when the line carries no identifier', () => {
    expect(purchaseLineMatchKeys({ ...EMPTY, name: 'Widget' })).toEqual([]);
  });
});

describe('toWishlistDraft', () => {
  it('maps the unit price to the target price and passes the link through', () => {
    expect(
      toWishlistDraft({
        ...EMPTY,
        name: 'Widget',
        unitPrice: 9.99,
        url: 'https://example.com/w',
        priority: 'high',
      }),
    ).toEqual({
      name: 'Widget',
      note: null,
      url: 'https://example.com/w',
      targetPrice: 9.99,
      priority: 'high',
    });
  });

  it('folds the supplier into the note, which the wishlist has no column for', () => {
    expect(toWishlistDraft({ ...EMPTY, name: 'Widget', supplierName: 'Fastenings Direct' }).note).toBe(
      'Supplier: Fastenings Direct',
    );
  });

  it('keeps an existing note alongside the supplier', () => {
    expect(
      toWishlistDraft({ ...EMPTY, name: 'Widget', note: 'Hex head', supplierName: 'Fastenings Direct' }).note,
    ).toBe('Hex head · Supplier: Fastenings Direct');
  });
});
