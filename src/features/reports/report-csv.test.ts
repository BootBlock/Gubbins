import { describe, it, expect } from 'vitest';
import { MS_PER_DAY } from '@/db/repositories';
import {
  buildConsumptionCsv,
  buildDeadStockCsv,
  buildMovementCsv,
  buildValuationCsv,
} from './report-csv';

describe('report CSV builders', () => {
  it('valuation CSV tags each row by dimension and quotes names with commas', () => {
    const csv = buildValuationCsv({
      totalValue: 30,
      totalQuantity: 15,
      unpricedItemCount: 0,
      byCategory: [{ id: 'a', name: 'Caps, big', value: 30, quantity: 15 }],
      byLocation: [{ id: 'l', name: 'Shelf', value: 30, quantity: 15 }],
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('dimension,group,quantity,value');
    expect(lines[1]).toBe('Category,"Caps, big",15,30');
    expect(lines[2]).toBe('Location,Shelf,15,30');
  });

  it('consumption CSV emits a single summary row with ISO window dates', () => {
    const csv = buildConsumptionCsv({
      windowStart: 0,
      windowEnd: 10 * MS_PER_DAY,
      windowDays: 10,
      totalConsumed: 50,
      perDay: 5,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('windowStart,windowEnd,windowDays,totalConsumed,perDay');
    expect(lines[1]).toBe('1970-01-01,1970-01-11,10,50,5');
  });

  it('movement CSV emits one row per bucket plus a totals row', () => {
    const csv = buildMovementCsv({
      windowStart: 0,
      windowEnd: 2 * MS_PER_DAY,
      buckets: [
        { start: 0, end: MS_PER_DAY, in: 4, out: 1 },
        { start: MS_PER_DAY, end: 2 * MS_PER_DAY, in: 0, out: 3 },
      ],
      totalIn: 4,
      totalOut: 4,
    });
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4); // header + 2 buckets + total
    expect(lines[3]).toBe('Total,,4,4');
  });

  it('dead-stock CSV emits one row per idle line', () => {
    const csv = buildDeadStockCsv({
      sinceDays: 30,
      lines: [{ id: 'a', name: 'Idle', quantity: 4, idleDays: 90, value: 20 }],
      totalValue: 20,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item,quantity,idleDays,value');
    expect(lines[1]).toBe('Idle,4,90,20');
  });
});
