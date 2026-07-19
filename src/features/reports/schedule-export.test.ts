import { describe, it, expect } from 'vitest';
import { scheduleExportColumns, scheduleExportRows, scheduleExportFilename } from './schedule-export';
import type { InsuranceScheduleSummary, ScheduleLine } from './insurance-schedule';

const SUMMARY: InsuranceScheduleSummary = {
  groups: [
    { locationId: 'garage', locationPath: 'Garage', depth: 0, itemCount: 2, subtotal: 30 },
    { locationId: 'shelf', locationPath: 'Garage › Shelf A', depth: 1, itemCount: 1, subtotal: 10 },
    { locationId: null, locationPath: 'Unassigned', depth: 0, itemCount: 1, subtotal: 5 },
  ],
  grandTotal: 45,
  itemCount: 4,
  generatedAt: Date.parse('2026-07-09T00:00:00Z'),
};

function line(id: string, overrides: Partial<ScheduleLine> = {}): ScheduleLine {
  return {
    id,
    name: id,
    serialNo: null,
    condition: null,
    quantity: 1,
    acquiredAt: null,
    purchasePrice: null,
    warranty: 'none',
    replacementValue: 10,
    thumbnail: null,
    ...overrides,
  };
}

const LINES = new Map<string | null, ScheduleLine[]>([
  ['garage', [line('Drill'), line('Saw', { replacementValue: 20 })]],
  ['shelf', [line('Vice')]],
  [null, [line('Floating', { replacementValue: 5 })]],
]);

describe('scheduleExportRows', () => {
  it('flattens the document in room order, tagging each line with its room', () => {
    const rows = scheduleExportRows(SUMMARY, LINES);
    expect(rows.map((r) => [r.room, r.line.name])).toEqual([
      ['Garage', 'Drill'],
      ['Garage', 'Saw'],
      ['Garage › Shelf A', 'Vice'],
      ['Unassigned', 'Floating'],
    ]);
  });

  it('skips a room whose lines were never loaded rather than emitting a blank row', () => {
    const partial = new Map<string | null, ScheduleLine[]>([['garage', [line('Drill')]]]);
    const rows = scheduleExportRows(SUMMARY, partial);
    expect(rows.map((r) => r.line.name)).toEqual(['Drill']);
  });

  it('is empty for an empty document', () => {
    expect(scheduleExportRows({ ...SUMMARY, groups: [] }, LINES)).toEqual([]);
  });
});

describe('scheduleExportColumns', () => {
  it('carries no photo column — a spreadsheet cell cannot hold one', () => {
    const headers = scheduleExportColumns().map((c) => c.header);
    expect(headers).not.toContain('Photo');
    expect(headers).toEqual([
      'Room',
      'Item',
      'Serial',
      'Quantity',
      'Purchase price',
      'Acquired',
      'Warranty',
      'Condition',
      'Replacement value',
    ]);
  });

  it('keeps money and quantities as raw numbers so a spreadsheet can total them', () => {
    const columns = scheduleExportColumns();
    const row = { room: 'Garage', line: line('Drill', { quantity: 3, replacementValue: 12.5 }) };
    const valueOf = (header: string) => columns.find((c) => c.header === header)!.value(row);
    expect(valueOf('Quantity')).toBe(3);
    expect(valueOf('Replacement value')).toBe(12.5);
  });

  it('renders warranty and condition as their human labels', () => {
    const columns = scheduleExportColumns();
    const row = { room: 'Garage', line: line('Drill', { condition: 'MINT' }) };
    const valueOf = (header: string) => columns.find((c) => c.header === header)!.value(row);
    expect(typeof valueOf('Warranty')).toBe('string');
    expect(valueOf('Condition')).toBe('Mint');
  });
});

describe('scheduleExportFilename', () => {
  it('names the file for the chosen format', () => {
    expect(scheduleExportFilename('csv')).toBe('insurance-schedule.csv');
    expect(scheduleExportFilename('xlsx')).toBe('insurance-schedule.xlsx');
  });
});
